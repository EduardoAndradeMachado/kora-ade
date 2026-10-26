import { createServer as createHttpServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, createWebSocketStream } from 'ws'
import { relayHeaders } from '../relay/auth'
import { createRelay, type DeviceRecord, type RelayOptions } from '../relay/relay'
import { createIdentity, type Identity } from '../src/main/remote/identity'
import { sealEnvelope } from '../src/main/remote/envelope'
import { RelayLink, type LinkOptions, type LinkState } from '../src/main/remote/link'

const closers: (() => void)[] = []
// Os aparelhos com conta, no lugar do banco: o relay de cada teste consulta este mapa.
const registry = new Map<string, DeviceRecord>()
afterEach(() => {
  while (closers.length) closers.pop()!()
  registry.clear()
})
const register = (pc: Identity, phone?: Identity): void => {
  registry.set(pc.fingerprint, { accountId: 'conta', kind: 'pc', pcs: [], blocked: false })
  if (phone) registry.set(phone.fingerprint, { accountId: 'conta', kind: 'phone', pcs: [pc.fingerprint], blocked: false })
}

async function relayAt(port: number, options: Partial<RelayOptions> = {}): Promise<{ port: number; server: Server; stop(): Promise<void> }> {
  const server = createRelay({ directory: { find: async (fingerprint) => registry.get(fingerprint) ?? null }, ...options })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const stop = (): Promise<void> => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  closers.push(() => { void stop() })
  return { port: (server.address() as AddressInfo).port, server, stop }
}

function echo(): Server {
  return createHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => res.end(`eco: ${body}`))
  })
}

function link(port: number, pc: Identity, phone: Identity, extra: Partial<LinkOptions> = {}, registered = true): { link: RelayLink; states: LinkState[]; errors: (string | null)[] } {
  if (registered) register(pc, phone)
  const app = echo()
  const states: LinkState[] = []
  const errors: (string | null)[] = []
  const created = new RelayLink({
    url: `ws://127.0.0.1:${port}`, identity: pc,
    accepts: (fingerprint) => fingerprint === phone.fingerprint,
    deliver: (socket) => app.emit('connection', socket),
    onStatus: (status) => { states.push(status.state); errors.push(status.error) },
    minDelayMs: 30, maxDelayMs: 200, ...extra
  })
  closers.push(() => created.stop())
  created.start()
  return { link: created, states, errors }
}

async function phoneRequest(port: number, pc: Identity, phone: Identity, body: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/c/${pc.fingerprint}`, { headers: relayHeaders(phone, `/c/${pc.fingerprint}`) })
  closers.push(() => ws.terminate())
  const socket = await sealEnvelope(createWebSocketStream(ws), phone, pc.fingerprint)
  return new Promise((resolve, reject) => {
    const req = request({ createConnection: () => socket, method: 'POST', path: '/', headers: { 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve(text))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('a condição não aconteceu a tempo')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('link do PC com o relay', () => {
  it('entrega ao servidor do PC o celular pareado que chega pelo relay', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await relayAt(0)
    const { link: pcLink } = link(relay.port, pc, phone)
    await until(() => pcLink.status.state === 'conectado')
    expect(await phoneRequest(relay.port, pc, phone, 'oi')).toBe('eco: oi')
  })

  it('volta sozinho quando o relay cai e sobe de novo, sem ninguém mexer no PC', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    const first = await relayAt(0)
    const { link: pcLink, states } = link(first.port, pc, phone)
    await until(() => pcLink.status.state === 'conectado')
    await first.stop()
    await until(() => pcLink.status.state === 'reconectando')
    // Alguns segundos fora do ar: as tentativas continuam, sem desistir.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(pcLink.status.state).toBe('reconectando')
    await relayAt(first.port)
    await until(() => pcLink.status.state === 'conectado')
    expect(states).toEqual(expect.arrayContaining(['conectado', 'reconectando']))
    expect(await phoneRequest(first.port, pc, phone, 'de volta')).toBe('eco: de volta')
  })

  it('percebe a conexão morta pela falta do ping do relay e reconecta', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    // O relay não manda ping (como uma conexão que morreu no meio do caminho sem ninguém fechar).
    const relay = await relayAt(0, { pingMs: 60_000 })
    const { link: pcLink, states } = link(relay.port, pc, phone, { silenceMs: 200 })
    await until(() => pcLink.status.state === 'conectado')
    await until(() => states.filter((state) => state === 'conectado').length >= 2, 3_000)
    expect(states).toContain('reconectando')
  })

  it('PC sem conta: informa o motivo e espera o teto entre as tentativas, sem martelar o relay', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    let attempts = 0
    const relay = await relayAt(0, { seen: () => {}, directory: { find: async () => { attempts++; return null } } })
    const { link: pcLink } = link(relay.port, pc, phone, { minDelayMs: 30, maxDelayMs: 600 }, false)
    await until(() => pcLink.status.error?.includes('conta ativa') === true)
    expect(pcLink.status.state).toBe('reconectando')
    // Com a espera mínima de 30 ms seriam umas 20 tentativas em 1 s; no teto (300-600 ms), no máximo 3.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(attempts).toBeLessThanOrEqual(4)
  })

  it('pede ao relay pela conexão de controle, avisa a cada conexão aberta e falha na hora sem conexão', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await relayAt(0, { request: async (owner, body) => ({ owner: owner.fingerprint, body }) })
    let connected = 0
    const { link: pcLink } = link(relay.port, pc, phone, { onConnected: () => { connected++ } })
    await until(() => pcLink.status.state === 'conectado')
    expect(await pcLink.request({ op: 'celulares', lista: ['a'] })).toEqual({ owner: pc.fingerprint, body: { op: 'celulares', lista: ['a'] } })
    pcLink.reconnectNow()
    await until(() => connected === 2)
    pcLink.stop()
    await expect(pcLink.request({ op: 'celulares' })).rejects.toThrow('Sem conexão')
  })

  it('pedido em andamento falha quando a conexão cai, em vez de ficar esperando para sempre', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await relayAt(0, { request: () => new Promise(() => {}) })
    const { link: pcLink } = link(relay.port, pc, phone)
    await until(() => pcLink.status.state === 'conectado')
    const asked = pcLink.request({ op: 'lento' })
    pcLink.reconnectNow()
    await expect(asked).rejects.toThrow('caiu')
  })

  it('parado, não tenta mais; reconectar agora não espera a próxima tentativa', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await relayAt(0)
    const { link: pcLink, states } = link(relay.port, pc, phone, { minDelayMs: 60_000, maxDelayMs: 60_000 })
    await until(() => pcLink.status.state === 'conectado')
    pcLink.reconnectNow()
    // Uma conexão nova de verdade, na hora: com a espera de 60 s, só o reconectar agora faz isso caber no prazo.
    await until(() => states.filter((state) => state === 'conectado').length === 2)
    expect(states).toEqual(['conectando', 'conectado', 'conectando', 'conectado'])
    expect(await phoneRequest(relay.port, pc, phone, 'agora')).toBe('eco: agora')
    pcLink.stop()
    expect(pcLink.status.state).toBe('parado')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(pcLink.status.state).toBe('parado')
    await expect(phoneRequest(relay.port, pc, phone, 'ninguém')).rejects.toThrow()
  })
})

describe('link com relay que aceita e não responde', () => {
  it('o upgrade sem resposta vira reconexão, em vez de ficar conectando para sempre', async () => {
    const { createServer: createTcp } = await import('node:net')
    const mute = createTcp(() => {})
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve))
    closers.push(() => mute.close())
    const port = (mute.address() as AddressInfo).port
    const pc = createIdentity('PC')
    const states: LinkState[] = []
    const stuck = new RelayLink({ url: `ws://127.0.0.1:${port}`, identity: pc, accepts: () => true, deliver: () => {}, onStatus: (status) => { states.push(status.state) }, handshakeMs: 200, minDelayMs: 50, maxDelayMs: 100 })
    closers.push(() => stuck.stop())
    stuck.start()
    await until(() => states.includes('reconectando'), 3_000)
  })
})
