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

export interface RelayOptions {
  token: string
  // Caminho do health check (started_at), que não é adivinhável para não revelar o serviço a quem vasculha.
  healthPath?: string
  pingMs?: number
}

interface Waiting { pc: string; phone: WebSocket; queue: RawData[]; bytes: number; timer: NodeJS.Timeout }

const sizeOf = (data: RawData): number => Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : (data as Buffer).length

export function createRelay(options: RelayOptions): Server {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_QUEUED_BYTES })
  const controls = new Map<string, WebSocket>()
  const waiting = new Map<string, Waiting>()
  const started = new Date()
  const expected = Buffer.from(`Bearer ${options.token}`)

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
    if (options.healthPath && request.method === 'GET' && request.url === options.healthPath) {
      const uptime = Math.floor((Date.now() - started.getTime()) / 1000)
      const hours = Math.floor(uptime / 3600)
      const minutes = Math.floor((uptime % 3600) / 60)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return response.end(JSON.stringify({ started_at: started.toISOString(), uptime_seconds: uptime, uptime_human: hours ? `${hours}h ${minutes}m` : `${minutes}m` }))
    }
    response.writeHead(404, { 'content-length': '0' }).end()
  })

  server.on('upgrade', (request, socket, head) => {
    const parts = (request.url ?? '').split('?')[0]!.split('/').filter(Boolean)
    const [kind, id = '', session] = parts
    const route =
      kind === 's' && ID.test(id) && parts.length === 2 && authorized(request) ? 'control'
      : kind === 's' && ID.test(id) && parts.length === 3 && SESSION.test(session!) && waiting.get(session!)?.pc === id && authorized(request) ? 'data'
      : kind === 'c' && ID.test(id) && parts.length === 2 && controls.has(id) ? 'phone'
      : null
    if (!route) return refuse(socket)
    sockets.handleUpgrade(request, socket, head, (ws) => {
      keepAlive(ws)
      if (route === 'control') control(id, ws)
      else if (route === 'phone') phone(id, ws)
      else data(session!, ws)
    })
  })

  server.on('close', () => {
    for (const socket of sockets.clients) socket.terminate()
    for (const entry of waiting.values()) clearTimeout(entry.timer)
  })
  return server
}
