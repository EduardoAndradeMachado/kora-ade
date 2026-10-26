import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

// Ponto de encontro entre o celular e o PC. Não guarda nada e não lê nada: junta duas conexões e repassa os bytes do
// envelope de dentro, que só o celular e o PC abrem.
//   /s/<id>           controle do PC (com o token do relay): por onde ele fica sabendo que um celular chegou
//   /s/<id>/<sessão>  dados do PC para aquela sessão (com o token)
//   /c/<id>           o celular pedindo o PC <id>
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
const MAX_FAILURES = 20
const FAILURE_WINDOW_MS = 10 * 60_000
const BAN_MS = 30 * 60_000
const MAX_SOCKETS_PER_IP = 32

export interface RelayOptions {
  token: string
  // Caminho do health check (started_at), que não é adivinhável para não revelar o serviço a quem vasculha.
  healthPath?: string
  pingMs?: number
  // Atrás do proxy do EasyPanel todos chegam do IP do proxy: o IP de quem pediu vem no X-Forwarded-For. Só ligar com o
  // proxy na frente, porque sem ele qualquer um forja esse cabeçalho.
  trustProxy?: boolean
  maxFailures?: number
  banMs?: number
  maxMessageBytes?: number
}

interface Waiting { pc: string; phone: WebSocket; queue: RawData[]; bytes: number; timer: NodeJS.Timeout }

const sizeOf = (data: RawData): number => Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : (data as Buffer).length

export function createRelay(options: RelayOptions): Server {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: options.maxMessageBytes ?? MAX_MESSAGE_BYTES })
  const controls = new Map<string, WebSocket>()
  const waiting = new Map<string, Waiting>()
  const started = new Date()
  const expected = Buffer.from(`Bearer ${options.token}`)
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

  const authorized = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers.authorization ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  const refuse = (socket: Duplex): void => { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n') }

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

  const control = (id: string, socket: WebSocket): void => {
    controls.get(id)?.terminate()
    controls.set(id, socket)
    socket.on('close', () => { if (controls.get(id) === socket) controls.delete(id) })
  }

  const phone = (id: string, socket: WebSocket): void => {
    const pc = controls.get(id)
    if (!pc || [...waiting.values()].filter((entry) => entry.pc === id).length >= MAX_WAITING_PER_PC) return socket.terminate()
    const session = randomBytes(16).toString('hex')
    const entry: Waiting = { pc: id, phone: socket, queue: [], bytes: 0, timer: setTimeout(() => { waiting.delete(session); socket.terminate() }, WAIT_PC_MS) }
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
    const { phone: other, queue } = entry
    for (const chunk of queue) socket.send(chunk, { binary: true })
    other.on('message', (chunk) => socket.send(chunk, { binary: true }))
    socket.on('message', (chunk) => other.send(chunk, { binary: true }))
    const end = (): void => { other.close(); socket.close() }
    other.on('close', end)
    socket.on('close', end)
  }

  const server = createServer((request, response) => {
    const ip = clientIp(request)
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

  server.on('upgrade', (request, socket, head) => {
    const ip = clientIp(request)
    if (banned(ip) || (openSockets.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) return refuse(socket)
    const parts = (request.url ?? '').split('?')[0]!.split('/').filter(Boolean)
    const [kind, id = '', session] = parts
    const route =
      kind === 's' && ID.test(id) && parts.length === 2 && authorized(request) ? 'control'
      : kind === 's' && ID.test(id) && parts.length === 3 && SESSION.test(session!) && waiting.get(session!)?.pc === id && authorized(request) ? 'data'
      : kind === 'c' && ID.test(id) && parts.length === 2 && controls.has(id) ? 'phone'
      : null
    if (!route) {
      // Celular procurando um PC desligado não é ataque: quem está viajando com o PC fora do ar segue tentando, e não
      // pode estar bloqueado quando o PC voltar. Adivinhar um ID de 256 bits não é viável, então isso não abre brecha.
      // O PC com o token certo chegando atrasado a uma sessão que já expirou (o celular desistiu) também não é ataque.
      if (!(kind === 'c' && ID.test(id) && parts.length === 2) && !(kind === 's' && authorized(request))) failed(ip)
      return refuse(socket)
    }
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
      if (route === 'control') control(id, ws)
      else if (route === 'phone') phone(id, ws)
      else data(session!, ws)
    })
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
  return server
}
