import { createServer as createHttpServer, request, type Server, type IncomingMessage } from 'node:http'
import { createPublicKey, X509Certificate } from 'node:crypto'
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
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

  it('todo certificado gerado é aceito pelo OpenSSL (o número de série sai no DER mínimo)', () => {
    // Antes, 1 em 256 saía com zero à esquerda no número de série e o OpenSSL recusava: aqui seriam ~8 casos.
    for (let i = 0; i < 2000; i++) expect(() => createIdentity('PC')).not.toThrow()
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

describe('relay contra abuso', () => {
  const upgrade = (port: number, path: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
    ws.on('open', () => { ws.terminate(); resolve(101) })
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); ws.terminate() })
    ws.on('error', () => {})
  })
  const auth = { authorization: `Bearer ${TOKEN}` }

  it('bloqueia por um tempo quem erra demais, inclusive com o token certo depois', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ token: TOKEN, maxFailures: 3, banMs: 400 }))
    for (let i = 0; i < 3; i++) expect(await upgrade(relay, `/s/${pcId.fingerprint}`, { authorization: 'Bearer chute' })).toBe(404)
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, auth)).toBe(404)
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, auth)).toBe(101)
  })

  it('celular procurando um PC desligado não é bloqueado, e entra quando o PC volta', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ token: TOKEN, maxFailures: 3, banMs: 60_000 }))
    for (let i = 0; i < 6; i++) expect(await upgrade(relay, `/c/${pcId.fingerprint}`)).toBe(404)
    const { app } = echoApp()
    pc(relay, pcId.fingerprint, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    expect(await phoneRequest(relay, pcId.fingerprint, phoneId, 'voltei')).toBe('eco: voltei')
  })

  it('atrás do proxy, bloqueia o IP de quem pediu e não o do proxy; sem proxy, ignora o cabeçalho', async () => {
    const pcId = createIdentity('PC')
    const behind = await listen(createRelay({ token: TOKEN, trustProxy: true, maxFailures: 2, banMs: 60_000 }))
    const attacker = { 'x-forwarded-for': '203.0.113.9' }
    for (let i = 0; i < 2; i++) expect(await upgrade(behind, '/inventado', attacker)).toBe(404)
    expect(await upgrade(behind, `/s/${pcId.fingerprint}`, { ...auth, ...attacker })).toBe(404)
    // O PC legítimo chega pelo mesmo proxy, com outro IP: segue entrando.
    expect(await upgrade(behind, `/s/${pcId.fingerprint}`, { ...auth, 'x-forwarded-for': '198.51.100.4' })).toBe(101)
    // Quem forja o começo da lista não escapa: vale o último IP, o que o proxy acrescentou.
    expect(await upgrade(behind, `/s/${pcId.fingerprint}`, { ...auth, 'x-forwarded-for': '198.51.100.4, 203.0.113.9' })).toBe(404)
    const direct = await listen(createRelay({ token: TOKEN, maxFailures: 2, banMs: 60_000 }))
    for (let i = 0; i < 2; i++) expect(await upgrade(direct, '/inventado', { 'x-forwarded-for': '203.0.113.50' })).toBe(404)
    expect(await upgrade(direct, `/s/${pcId.fingerprint}`, { ...auth, 'x-forwarded-for': '198.51.100.77' })).toBe(404)
  })
})

describe('relay como roda no contêiner', () => {
  const run = (env: Record<string, string>): ReturnType<typeof spawn> => {
    const child = spawn(process.execPath, ['main.ts'], { cwd: resolve('relay'), env: { ...process.env, ...env } })
    closers.push(() => child.kill())
    return child
  }
  const output = (child: ReturnType<typeof spawn>): Promise<{ code: number | null; text: string }> => new Promise((done) => {
    let text = ''
    child.stdout!.on('data', (chunk) => { text += chunk })
    child.stderr!.on('data', (chunk) => { text += chunk })
    child.on('exit', (code) => done({ code, text }))
  })

  it('recusa subir sem token forte ou com health previsível', async () => {
    expect(await output(run({ RELAY_TOKEN: 'curto', HEALTH_PATH: '/saude-a8f3k2p9' }))).toMatchObject({ code: 1, text: expect.stringContaining('RELAY_TOKEN') })
    expect(await output(run({ RELAY_TOKEN: 'x'.repeat(40), HEALTH_PATH: '/health' }))).toMatchObject({ code: 1, text: expect.stringContaining('HEALTH_PATH') })
  })

  it('sobe com a configuração do EasyPanel e responde o health no caminho secreto', async () => {
    const child = run({ RELAY_TOKEN: 'x'.repeat(40), HEALTH_PATH: '/saude-a8f3k2p9', PORT: '0', TRUST_PROXY: '1' })
    const port = await new Promise<number>((done, fail) => {
      child.stdout!.on('data', (chunk) => { const match = /porta (\d+)/.exec(String(chunk)); if (match) done(Number(match[1])) })
      child.on('exit', (code) => fail(new Error(`saiu com ${code}`)))
    })
    const health = await fetch(`http://127.0.0.1:${port}/saude-a8f3k2p9`)
    expect(health.status).toBe(200)
    expect((await health.json()).started_at).toEqual(expect.any(String))
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
  })
})

describe('relay com tráfego pesado e conexões ruins', () => {
  const upgrade = (port: number, path: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
    ws.on('open', () => { ws.terminate(); resolve(101) })
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); ws.terminate() })
    ws.on('error', () => {})
  })

  it('uma resposta de vários MB passa inteira, como um arquivo grande da tela', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ token: TOKEN }))
    const app = createHttpServer((_req, res) => res.end(Buffer.alloc(3 * 1024 * 1024, 7)))
    pc(relay, pcId.fingerprint, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    const ws = new WebSocket(`ws://127.0.0.1:${relay}/c/${pcId.fingerprint}`)
    closers.push(() => ws.terminate())
    const socket = await sealEnvelope(createWebSocketStream(ws), phoneId, pcId.fingerprint)
    const size = await new Promise<number>((resolve, reject) => {
      request({ createConnection: () => socket, path: '/' }, (res) => {
        let total = 0
        res.on('data', (chunk: Buffer) => { total += chunk.length })
        res.on('end', () => resolve(total))
      }).on('error', reject).end()
    })
    expect(size).toBe(3 * 1024 * 1024)
  })

  it('um quadro acima do limite derruba só aquela conexão, e o relay segue atendendo os outros', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ token: TOKEN, maxMessageBytes: 64 * 1024 }))
    const { app } = echoApp()
    pc(relay, pcId.fingerprint, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    const abusive = new WebSocket(`ws://127.0.0.1:${relay}/c/${pcId.fingerprint}`)
    closers.push(() => abusive.terminate())
    abusive.on('error', () => {})
    await new Promise((resolve) => abusive.on('open', resolve))
    const closed = new Promise((resolve) => abusive.on('close', resolve))
    abusive.send(Buffer.alloc(200 * 1024))
    await closed
    expect(await phoneRequest(relay, pcId.fingerprint, phoneId, 'ainda de pé')).toBe('eco: ainda de pé')
  })

  it('o PC atrasado para uma sessão que já expirou não é bloqueado, mesmo muitas vezes', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ token: TOKEN, maxFailures: 3, banMs: 60_000 }))
    const auth = { authorization: `Bearer ${TOKEN}` }
    for (let i = 0; i < 6; i++) expect(await upgrade(relay, `/s/${pcId.fingerprint}/${'0'.repeat(31)}${i}`, auth)).toBe(404)
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, auth)).toBe(101)
  })
})

describe('relay com quem não lê', () => {
  it('o destino que para de ler derruba a sessão em vez de acumular memória na VPS', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ token: TOKEN, maxBufferedBytes: 256 * 1024 }))
    // O PC manda uma resposta enorme no ritmo que o relay aceita; o celular nunca lê o que chega.
    // Os buffers do kernel no loopback engolem dezenas de MB, então o fluxo precisa ser bem maior que eles.
    const TOTAL = 256 * 1024 * 1024
    const outcome = new Promise<'cortada' | 'completa'>((resolve) => {
      const app = createHttpServer((_req, res) => {
        const chunk = Buffer.alloc(1024 * 1024, 1)
        let sent = 0
        const pump = (): void => {
          while (sent < TOTAL) {
            sent += chunk.length
            if (!res.write(chunk)) return void res.once('drain', pump)
          }
          res.end()
        }
        res.on('close', () => resolve(res.writableFinished ? 'completa' : 'cortada'))
        pump()
      })
      pc(relay, pcId.fingerprint, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    })
    await waitControl()
    const ws = new WebSocket(`ws://127.0.0.1:${relay}/c/${pcId.fingerprint}`)
    closers.push(() => ws.terminate())
    const socket = await sealEnvelope(createWebSocketStream(ws), phoneId, pcId.fingerprint)
    ;(ws as unknown as { _socket: { pause(): void } })._socket.pause()
    request({ createConnection: () => socket, path: '/' }, () => {}).on('error', () => {}).end()
    // Sem o teto, o relay guardaria os 256 MB na memória e a resposta terminaria; com ele, a sessão cai no meio.
    expect(await outcome).toBe('cortada')
  }, 30_000)
})
