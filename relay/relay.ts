import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { parseRelayAuth, verifyRelayAuth } from './auth.ts'

// Ponto de encontro entre o celular e o PC. Não guarda nada e não lê nada: junta duas conexões e repassa os bytes do
// envelope de dentro, que só o celular e o PC abrem.
//   /s/<id>           controle do PC <id>: por onde ele fica sabendo que um celular chegou e faz pedidos ao relay
//   /s/<id>/<sessão>  dados do PC para aquela sessão
//   /c/<id>           um celular registrado pelo PC <id> pedindo para falar com ele
//   /a/...            cadastro e login da conta (fora do relay.ts, pelo gancho api)
// Toda conexão prova a posse da chave do aparelho (auth.ts), e o aparelho precisa estar registrado numa conta ativa.
// Qualquer outra coisa recebe 404 sem corpo: quem vasculha não descobre o que roda aqui.

const ID = /^[0-9a-f]{64}$/
const SESSION = /^[0-9a-f]{32}$/
const PING_MS = 25_000
const WAIT_PC_MS = 10_000
const MAX_WAITING_PER_PC = 8
const MAX_QUEUED_BYTES = 1 << 20
// O TLS do PC junta vários registros numa escrita só: uma resposta grande (um arquivo da tela, o APK) chega como uma
// mensagem de vários MB. O limite só barra o absurdo.
const MAX_MESSAGE_BYTES = 64 << 20
const MAX_BUFFERED_BYTES = 32 << 20
const MAX_FAILURES = 20
const FAILURE_WINDOW_MS = 10 * 60_000
const BAN_MS = 30 * 60_000
const MAX_SOCKETS_PER_IP = 32

// pcs: os PCs que o celular pode procurar (o mesmo celular pareado com o PC de casa e o do trabalho); vazio no PC.
export interface DeviceRecord { accountId: string; kind: 'pc' | 'phone'; pcs: string[]; blocked: boolean }
export interface Owner { fingerprint: string; accountId: string }
export interface UsageDelta { bytesIn?: number; bytesOut?: number; sessions?: number; seconds?: number }

export interface RelayOptions {
  // Quem é cada impressão digital: a conta, o tipo e, no celular, o PC que o registrou.
  directory: {
    find(fingerprint: string): Promise<DeviceRecord | null>
    // Celular que o PC ainda não informou procurando por ele: só entra se o PC estiver com o QR aberto, e aí já fica
    // registrado nele (null: recusa).
    admit?(phone: string, pc: string): Promise<DeviceRecord | null>
  }
  // Consumo por aparelho; chamado a cada mensagem repassada, então tem de ser só uma soma em memória.
  usage?(fingerprint: string, delta: UsageDelta): void
  // Cada conexão aceita: o IP e o X-Kora-Client (sistema e versão) de quem chegou.
  seen?(fingerprint: string, info: { ip: string; client: string }): void
  // Pedido do PC pela conexão de controle (registrar os celulares, admin); a resposta volta por ela.
  request?(owner: Owner, body: unknown): Promise<unknown>
  // Cadastro e login (/a/...): não contam como tentativa de invasão, e quem atende limita por IP.
  api?(request: IncomingMessage, response: ServerResponse, ip: string): void
  // Caminho do health check (started_at), que não é adivinhável para não revelar o serviço a quem vasculha.
  healthPath?: string
  pingMs?: number
  // Atrás do proxy do EasyPanel todos chegam do IP do proxy: o IP de quem pediu vem no X-Forwarded-For. Só ligar com o
  // proxy na frente, porque sem ele qualquer um forja esse cabeçalho.
  trustProxy?: boolean
  maxFailures?: number
  banMs?: number
  maxMessageBytes?: number
  maxBufferedBytes?: number
}

interface Waiting { pc: string; phone: WebSocket; phoneId: string; queue: RawData[]; bytes: number; timer: NodeJS.Timeout }

export type Relay = Server & {
  // Conta bloqueada: todas as conexões dela caem na hora (o diretório já recusa as próximas).
  dropAccount(accountId: string): void
  // Impressões digitais com conexão aberta agora (PC no controle, celular numa sessão).
  online(): Set<string>
}

const CONTROL_MESSAGE_BYTES = 64 * 1024
const CLIENT_INFO = /^[\w./ ;:()+-]{1,120}$/

const sizeOf = (data: RawData): number => Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : (data as Buffer).length

export function createRelay(options: RelayOptions): Relay {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: options.maxMessageBytes ?? MAX_MESSAGE_BYTES })
  const controls = new Map<string, WebSocket>()
  const waiting = new Map<string, Waiting>()
  const started = new Date()
  const byAccount = new Map<string, Set<WebSocket>>()
  // Celular com sessão aberta agora, por conexão: o online() da tela de admin.
  const live = new Map<WebSocket, string>()
  const failures = new Map<string, { count: number; since: number; bannedUntil: number }>()
  const openSockets = new Map<string, number>()

  // O proxy acrescenta o IP de quem conectou no fim da lista; o começo dela pode ter sido escrito por quem pediu.
  const clientIp = (request: IncomingMessage): string => {
    const forwarded = options.trustProxy ? String(request.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean).at(-1) : undefined
    return forwarded ?? request.socket.remoteAddress ?? ''
  }
  const banned = (ip: string): boolean => (failures.get(ip)?.bannedUntil ?? 0) > Date.now()
  // Quem insiste em token errado ou caminho inventado fica bloqueado por um tempo, com a mesma resposta de sempre.
  const failed = (ip: string): void => {
    const now = Date.now()
    const current = failures.get(ip)
    const entry = current && now - current.since < FAILURE_WINDOW_MS ? current : { count: 0, since: now, bannedUntil: 0 }
    entry.count++
    if (entry.count >= (options.maxFailures ?? MAX_FAILURES)) entry.bannedUntil = now + (options.banMs ?? BAN_MS)
    failures.set(ip, entry)
  }
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of failures) if (entry.bannedUntil <= now && now - entry.since >= FAILURE_WINDOW_MS) failures.delete(ip)
  }, 60_000)
  sweep.unref()

  // Assinatura inválida é tentativa de invasão; assinatura boa de aparelho sem registro (ou de conta bloqueada) é só
  // recusa, com 403, para o Kora parar de insistir e mostrar o motivo em vez de ser bloqueado pelo IP.
  const authenticate = async (request: IncomingMessage, path: string, kind: 'pc' | 'phone', target: string): Promise<Owner | 'invalid' | 'denied'> => {
    const auth = parseRelayAuth(request.headers.authorization, request.headers['x-kora-certificate'] as string | undefined)
    if (!auth || !verifyRelayAuth(auth, path)) return 'invalid'
    let device = await options.directory.find(auth.fingerprint)
    if (kind === 'phone' && (!device || (device.kind === 'phone' && !device.pcs.includes(target))) && options.directory.admit) {
      device = await options.directory.admit(auth.fingerprint, target)
    }
    if (!device || device.blocked || device.kind !== kind || (kind === 'phone' && !device.pcs.includes(target))) return 'denied'
    return { fingerprint: auth.fingerprint, accountId: device.accountId }
  }
  const refuse = (socket: Duplex, status = '404 Not Found'): void => { socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`) }

  // Conexão móvel cai sem avisar: sem resposta ao ping, ela é derrubada e o outro lado reconecta.
  const keepAlive = (socket: WebSocket): void => {
    let alive = true
    socket.on('pong', () => { alive = true })
    const timer = setInterval(() => {
      if (!alive) return socket.terminate()
      alive = false
      socket.ping()
    }, options.pingMs ?? PING_MS)
    socket.on('close', () => clearInterval(timer))
  }

  const control = (owner: Owner, socket: WebSocket): void => {
    const id = owner.fingerprint
    controls.get(id)?.terminate()
    controls.set(id, socket)
    let counted = Date.now()
    const count = (): void => {
      const now = Date.now()
      options.usage?.(id, { seconds: Math.round((now - counted) / 1000) })
      counted = now
    }
    const minute = setInterval(count, 60_000)
    socket.on('close', () => {
      clearInterval(minute)
      count()
      if (controls.get(id) === socket) controls.delete(id)
    })
    // Pedidos do PC: {id, ...corpo}; a resposta leva o mesmo id.
    socket.on('message', (raw, binary) => {
      if (binary || sizeOf(raw) > CONTROL_MESSAGE_BYTES || !options.request) return
      let message: { id?: unknown }
      try { message = JSON.parse(String(raw)) as { id?: unknown } } catch { return }
      if (typeof message.id !== 'number') return
      const { id: requestId, ...body } = message
      options.request({ fingerprint: owner.fingerprint, accountId: owner.accountId }, body).then(
        (result) => socket.send(JSON.stringify({ id: requestId, ok: true, result })),
        (error: unknown) => socket.send(JSON.stringify({ id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) }))
      )
    })
  }

  const phone = (id: string, owner: Owner, socket: WebSocket): void => {
    const pc = controls.get(id)
    if (!pc || [...waiting.values()].filter((entry) => entry.pc === id).length >= MAX_WAITING_PER_PC) return socket.terminate()
    const session = randomBytes(16).toString('hex')
    const entry: Waiting = { pc: id, phone: socket, phoneId: owner.fingerprint, queue: [], bytes: 0, timer: setTimeout(() => { waiting.delete(session); socket.terminate() }, WAIT_PC_MS) }
    waiting.set(session, entry)
    // O celular começa o aperto de mãos antes de o PC chegar: o que ele mandar fica guardado até a outra ponta existir.
    socket.on('message', (data) => {
      if (!waiting.has(session)) return
      entry.queue.push(data)
      entry.bytes += sizeOf(data)
      if (entry.bytes > MAX_QUEUED_BYTES) socket.terminate()
    })
    socket.on('close', () => { if (waiting.get(session) === entry) { clearTimeout(entry.timer); waiting.delete(session) } })
    pc.send(JSON.stringify({ sessao: session }))
  }

  const data = (session: string, socket: WebSocket): void => {
    const entry = waiting.get(session)
    if (!entry) return socket.terminate()
    clearTimeout(entry.timer)
    waiting.delete(session)
    const { phone: other, queue, pc, phoneId } = entry
    const limit = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES
    options.usage?.(pc, { sessions: 1 })
    options.usage?.(phoneId, { sessions: 1 })
    const forward = (to: WebSocket, chunk: RawData): void => {
      if (to.bufferedAmount > limit) {
        to.terminate()
        return
      }
      const bytes = sizeOf(chunk)
      const [from, into] = to === socket ? [phoneId, pc] : [pc, phoneId]
      options.usage?.(from, { bytesOut: bytes })
      options.usage?.(into, { bytesIn: bytes })
      to.send(chunk, { binary: true })
    }
    for (const chunk of queue) forward(socket, chunk)
    other.on('message', (chunk) => forward(socket, chunk))
    socket.on('message', (chunk) => forward(other, chunk))
    const end = (): void => { other.close(); socket.close() }
    other.on('close', end)
    socket.on('close', end)
  }

  const server = createServer((request, response) => {
    const ip = clientIp(request)
    if (!banned(ip) && options.api && (request.url ?? '').startsWith('/a/')) return options.api(request, response, ip)
    if (!banned(ip) && options.healthPath && request.method === 'GET' && request.url === options.healthPath) {
      const uptime = Math.floor((Date.now() - started.getTime()) / 1000)
      const hours = Math.floor(uptime / 3600)
      const minutes = Math.floor((uptime % 3600) / 60)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return response.end(JSON.stringify({ started_at: started.toISOString(), uptime_seconds: uptime, uptime_human: hours ? `${hours}h ${minutes}m` : `${minutes}m` }))
    }
    if (!banned(ip)) failed(ip)
    response.writeHead(404, { 'content-length': '0' }).end()
  })

  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const ip = clientIp(request)
    if (banned(ip) || (openSockets.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) return refuse(socket)
    const path = (request.url ?? '').split('?')[0]!
    const parts = path.split('/').filter(Boolean)
    const [kind, id = '', session] = parts
    const shape =
      kind === 's' && ID.test(id) && parts.length === 2 ? 'control'
      : kind === 's' && ID.test(id) && parts.length === 3 && SESSION.test(session!) ? 'data'
      : kind === 'c' && ID.test(id) && parts.length === 2 ? 'phone'
      : null
    const owner = shape ? await authenticate(request, path, shape === 'phone' ? 'phone' : 'pc', id) : 'invalid'
    // Assinatura do PC para o caminho de outro PC também é forjada: ninguém fala em nome de outra impressão digital.
    if (owner === 'invalid' || (shape !== 'phone' && owner !== 'denied' && owner.fingerprint !== id)) {
      failed(ip)
      return refuse(socket)
    }
    // Celular de outro PC é recusa, não ataque: o dono dele só errou de PC (ou desfez o pareamento).
    if (owner === 'denied') return refuse(socket, '403 Forbidden')
    // Celular procurando um PC desligado não é ataque: quem está viajando com o PC fora do ar segue tentando, e não pode
    // estar bloqueado quando o PC voltar. O PC chegando atrasado a uma sessão que já expirou (o celular desistiu) também
    // não. Os dois já provaram quem são.
    if ((shape === 'phone' && !controls.has(id)) || (shape === 'data' && waiting.get(session!)?.pc !== id)) return refuse(socket)
    if (socket.destroyed) return
    const client = String(request.headers['x-kora-client'] ?? '')
    options.seen?.(owner.fingerprint, { ip, client: CLIENT_INFO.test(client) ? client : '' })
    sockets.handleUpgrade(request, socket, head, (ws) => {
      // Mensagem acima do limite ou quadro malformado: a ws avisa com 'error', e sem ninguém ouvindo o processo inteiro
      // cairia, derrubando todos os PCs e celulares. Só esta conexão fecha.
      ws.on('error', () => ws.terminate())
      openSockets.set(ip, (openSockets.get(ip) ?? 0) + 1)
      ws.on('close', () => {
        const left = (openSockets.get(ip) ?? 1) - 1
        if (left > 0) openSockets.set(ip, left)
        else openSockets.delete(ip)
      })
      keepAlive(ws)
      const mine = byAccount.get(owner.accountId) ?? new Set<WebSocket>()
      byAccount.set(owner.accountId, mine.add(ws))
      ws.on('close', () => {
        mine.delete(ws)
        if (mine.size === 0 && byAccount.get(owner.accountId) === mine) byAccount.delete(owner.accountId)
      })
      if (shape === 'control') control(owner, ws)
      else if (shape === 'phone') {
        live.set(ws, owner.fingerprint)
        ws.on('close', () => live.delete(ws))
        phone(id, owner, ws)
      }
      else data(session!, ws)
    })
  }
  // O diretório pode estar fora do ar: a conexão recebe 503 e o aparelho tenta de novo, sem contar como ataque.
  server.on('upgrade', (request, socket, head) => {
    void upgrade(request, socket as Duplex, head).catch(() => refuse(socket as Duplex, '503 Service Unavailable'))
  })

  // O close do Node espera as conexões acabarem, e as do WebSocket não acabam sozinhas: sem derrubá-las antes, o
  // desligamento (SIGTERM do redeploy) ficaria parado até o Docker matar o processo.
  const close = server.close.bind(server)
  server.close = (callback) => {
    clearInterval(sweep)
    for (const socket of sockets.clients) socket.terminate()
    for (const entry of waiting.values()) clearTimeout(entry.timer)
    return close(callback)
  }
  return Object.assign(server, {
    dropAccount(accountId: string): void {
      for (const socket of byAccount.get(accountId) ?? []) socket.terminate()
    },
    online(): Set<string> {
      return new Set([...controls.keys(), ...[...live.values()]])
    }
  })
}
