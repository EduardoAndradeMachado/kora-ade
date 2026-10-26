import { createServer as createHttpServer, request, type Server, type IncomingMessage } from 'node:http'
import { createPublicKey, X509Certificate } from 'node:crypto'
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, createWebSocketStream } from 'ws'
import { createRelay } from '../relay/relay'
import { createIdentity, type Identity } from '../src/main/remote/identity'
import { openEnvelope, sealEnvelope } from '../src/main/remote/envelope'

const TOKEN = 'token-do-relay-de-teste'
const closers: (() => void)[] = []
afterEach(() => { while (closers.length) closers.pop()!() })

const listen = async <T extends Server | TcpServer>(server: T): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return (server.address() as AddressInfo).port
}

// Grampo entre o celular e o relay: guarda tudo o que passa pela rede, como veria quem estivesse no meio.
async function sniffer(target: number): Promise<{ port: number; seen: () => string }> {
  const chunks: Buffer[] = []
  const server = createTcpServer((client) => {
    const upstream = tcpConnect(target, '127.0.0.1')
    client.on('data', (chunk: Buffer) => { chunks.push(chunk); upstream.write(chunk) })
    upstream.on('data', (chunk: Buffer) => { chunks.push(chunk); client.write(chunk) })
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  return { port: await listen(server), seen: () => Buffer.concat(chunks).toString('latin1') }
}

// O PC: fica no controle do relay e, a cada celular que chega, abre o envelope e entrega o pedido ao servidor HTTP dele.
function pc(relay: number, id: string, me: Identity, accepts: (fingerprint: string) => boolean, app: Server): { envelopes: Promise<unknown>[] } {
  const envelopes: Promise<unknown>[] = []
  const control = new WebSocket(`ws://127.0.0.1:${relay}/s/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } })
  closers.push(() => control.terminate())
  control.on('message', (message) => {
    const { sessao } = JSON.parse(String(message)) as { sessao: string }
    const data = new WebSocket(`ws://127.0.0.1:${relay}/s/${id}/${sessao}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    closers.push(() => data.terminate())
    const opened = openEnvelope(createWebSocketStream(data), me, accepts).then((socket) => { app.emit('connection', socket) })
    opened.catch(() => {})
    envelopes.push(opened)
  })
  return { envelopes }
}

const waitControl = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

async function phoneRequest(relay: number, pcId: string, me: Identity, body: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${relay}/c/${pcId}`)
  closers.push(() => ws.terminate())
  const socket = await sealEnvelope(createWebSocketStream(ws), me, pcId)
  return new Promise((resolve, reject) => {
    const req = request({ createConnection: () => socket, method: 'POST', path: '/eco', headers: { 'content-length': Buffer.byteLength(body) } }, (res: IncomingMessage) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve(text))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function echoApp(): { app: Server; requests: string[] } {
  const requests: string[] = []
  const app = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { requests.push(body); res.end(`eco: ${body}`) })
  })
  return { app, requests }
}

describe('identidade do aparelho', () => {
  it('gera um certificado que o OpenSSL lê, assinado pela própria chave, com o ID igual à impressão digital', () => {
    const me = createIdentity('Eduardo · PC')
    const cert = new X509Certificate(me.cert)
    expect(cert.subject).toBe('CN=Eduardo · PC')
    expect(cert.verify(createPublicKey(me.key))).toBe(true)
    expect(me.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(me.fingerprint).toBe(cert.fingerprint256.replaceAll(':', '').toLowerCase())
    // Validade longa, depois de 2049: o pareamento não expira, e a data precisa sair no formato que o leitor aceita.
    expect(new Date(cert.validTo).getUTCFullYear()).toBeGreaterThan(2100)
    expect(createIdentity('Eduardo · PC').fingerprint).not.toBe(me.fingerprint)
  })
})

describe('envelope de dentro pelo relay', () => {
  it('o celular pareado fala com o PC pelo relay, e quem está no meio só vê bytes cifrados', async () => {
    const [pcId, phoneId] = await Promise.all([createIdentity('PC'), createIdentity('Celular')])
    const relay = await listen(createRelay({ token: TOKEN }))
    const wire = await sniffer(relay)
    const { app, requests } = echoApp()
    pc(relay, pcId.fingerprint, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    expect(await phoneRequest(wire.port, pcId.fingerprint, phoneId, 'SEGREDO-DO-TERMINAL')).toBe('eco: SEGREDO-DO-TERMINAL')
    expect(requests).toEqual(['SEGREDO-DO-TERMINAL'])
    expect(wire.seen()).toContain(`/c/${pcId.fingerprint}`)
    expect(wire.seen()).not.toContain('SEGREDO-DO-TERMINAL')
    expect(wire.seen()).not.toContain('POST /eco')
  })

  it('o PC recusa um celular que não foi pareado e não entrega nada ao servidor', async () => {
    const [pcId, paired, stranger] = await Promise.all([createIdentity('PC'), createIdentity('Pareado'), createIdentity('Estranho')])
    const relay = await listen(createRelay({ token: TOKEN }))
    const { app, requests } = echoApp()
    const side = pc(relay, pcId.fingerprint, pcId, (fingerprint) => fingerprint === paired.fingerprint, app)
    await waitControl()
    await expect(phoneRequest(relay, pcId.fingerprint, stranger, 'entrar')).rejects.toThrow()
    await expect(side.envelopes[0]).rejects.toThrow('não é o do pareamento')
    expect(requests).toEqual([])
  })

  it('o celular recusa um PC que não é o do QR, mesmo que o relay o entregue no lugar do verdadeiro', async () => {
    const [real, impostor, phoneId] = await Promise.all([createIdentity('PC'), createIdentity('Impostor'), createIdentity('Celular')])
    const relay = await listen(createRelay({ token: TOKEN }))
    const { app, requests } = echoApp()
    // O impostor tem o token do relay e se registra com o ID do PC verdadeiro, aceitando qualquer celular.
    pc(relay, real.fingerprint, impostor, () => true, app)
    await waitControl()
    await expect(phoneRequest(relay, real.fingerprint, phoneId, 'segredo')).rejects.toThrow('não é o do pareamento')
    expect(requests).toEqual([])
  })
})

describe('relay discreto', () => {
  const status = (port: number, path: string, headers: Record<string, string> = {}): Promise<{ code: number; body: string; headers: Record<string, unknown> }> => new Promise((resolve, reject) => {
    request({ port, host: '127.0.0.1', path, headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ code: res.statusCode!, body, headers: res.headers }))
    }).on('error', reject).end()
  })
  const upgrade = (port: number, path: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
    ws.on('open', () => { ws.terminate(); resolve(101) })
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); ws.terminate() })
    ws.on('error', () => {})
  })

  it('responde 404 vazio a quem vasculha e só abre o caminho certo, com o token certo', async () => {
    const pcId = await createIdentity('PC')
    const relay = await listen(createRelay({ token: TOKEN, healthPath: '/saude-a8f3' }))
    for (const path of ['/', '/health', '/c', '/s/123']) expect(await status(relay, path)).toMatchObject({ code: 404, body: '' })
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`)).toBe(404)
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, { authorization: 'Bearer outro-token' })).toBe(404)
    expect(await upgrade(relay, `/c/${pcId.fingerprint}`)).toBe(404)
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, { authorization: `Bearer ${TOKEN}` })).toBe(101)
    const health = await status(relay, '/saude-a8f3')
    expect(health.code).toBe(200)
    expect(health.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(health.body)).toMatchObject({ started_at: expect.any(String), uptime_seconds: expect.any(Number) })
    expect(health.body.toLowerCase()).not.toContain('kora')
  })
})
