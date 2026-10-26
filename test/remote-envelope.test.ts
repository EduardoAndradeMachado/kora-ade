import { createServer as createHttpServer, request, type Server, type IncomingMessage } from 'node:http'
import { createPublicKey, X509Certificate } from 'node:crypto'
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { duplexPair } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, createWebSocketStream } from 'ws'
import { relayHeaders } from '../relay/auth'
import { createRelay, type DeviceRecord, type Owner, type UsageDelta } from '../relay/relay'
import { createIdentity, type Identity } from '../src/main/remote/identity'
import { openEnvelope, sealEnvelope } from '../src/main/remote/envelope'

const ACCOUNT = 'conta-de-teste'
const closers: (() => void)[] = []
afterEach(() => { while (closers.length) closers.pop()!() })

const listen = async <T extends Server | TcpServer>(server: T): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return (server.address() as AddressInfo).port
}

// Diretório em memória no lugar do banco: o relay confere a assinatura e o certificado do mesmo jeito.
function directory(pcs: Identity[], phones: [phone: Identity, pc: Identity][] = []): { find(fingerprint: string): Promise<DeviceRecord | null>; map: Map<string, DeviceRecord> } {
  const map = new Map<string, DeviceRecord>()
  for (const pc of pcs) map.set(pc.fingerprint, { accountId: ACCOUNT, kind: 'pc', pcs: [], blocked: false })
  for (const [phone, pc] of phones) {
    const known = map.get(phone.fingerprint)
    map.set(phone.fingerprint, { accountId: ACCOUNT, kind: 'phone', pcs: [...(known?.pcs ?? []), pc.fingerprint], blocked: false })
  }
  return { map, find: async (fingerprint) => map.get(fingerprint) ?? null }
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
function pc(relay: number, me: Identity, accepts: (fingerprint: string) => boolean, app: Server): { envelopes: Promise<unknown>[]; control: WebSocket } {
  const envelopes: Promise<unknown>[] = []
  const control = new WebSocket(`ws://127.0.0.1:${relay}/s/${me.fingerprint}`, { headers: relayHeaders(me, `/s/${me.fingerprint}`) })
  closers.push(() => control.terminate())
  control.on('message', (message) => {
    const { sessao } = JSON.parse(String(message)) as { sessao?: string }
    if (!sessao) return
    const path = `/s/${me.fingerprint}/${sessao}`
    const data = new WebSocket(`ws://127.0.0.1:${relay}${path}`, { headers: relayHeaders(me, path) })
    closers.push(() => data.terminate())
    const opened = openEnvelope(createWebSocketStream(data), me, accepts).then((socket) => { app.emit('connection', socket) })
    opened.catch(() => {})
    envelopes.push(opened)
  })
  return { envelopes, control }
}

const waitControl = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

function phoneSocket(relay: number, pcId: string, me: Identity): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${relay}/c/${pcId}`, { headers: relayHeaders(me, `/c/${pcId}`) })
  closers.push(() => ws.terminate())
  return ws
}

async function phoneRequest(relay: number, pcId: string, me: Identity, body: string): Promise<string> {
  const socket = await sealEnvelope(createWebSocketStream(phoneSocket(relay, pcId, me)), me, pcId)
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

const upgrade = (port: number, path: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
  ws.on('open', () => { ws.terminate(); resolve(101) })
  ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); ws.terminate() })
  ws.on('error', () => {})
})

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
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ directory: directory([pcId], [[phoneId, pcId]]) }))
    const wire = await sniffer(relay)
    const { app, requests } = echoApp()
    pc(relay, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    expect(await phoneRequest(wire.port, pcId.fingerprint, phoneId, 'SEGREDO-DO-TERMINAL')).toBe('eco: SEGREDO-DO-TERMINAL')
    expect(requests).toEqual(['SEGREDO-DO-TERMINAL'])
    expect(wire.seen()).toContain(`/c/${pcId.fingerprint}`)
    expect(wire.seen()).not.toContain('SEGREDO-DO-TERMINAL')
    expect(wire.seen()).not.toContain('POST /eco')
  })

  it('o PC recusa no envelope um celular que ele não pareou, mesmo que o relay o deixe passar', async () => {
    const [pcId, paired, stranger] = [createIdentity('PC'), createIdentity('Pareado'), createIdentity('Estranho')]
    // O relay acha que o estranho é deste PC (banco adulterado, por exemplo): a última palavra é do PC.
    const relay = await listen(createRelay({ directory: directory([pcId], [[paired, pcId], [stranger, pcId]]) }))
    const { app, requests } = echoApp()
    const side = pc(relay, pcId, (fingerprint) => fingerprint === paired.fingerprint, app)
    await waitControl()
    await expect(phoneRequest(relay, pcId.fingerprint, stranger, 'entrar')).rejects.toThrow()
    await expect(side.envelopes[0]).rejects.toThrow('não é o do pareamento')
    expect(requests).toEqual([])
  })

  it('o celular recusa um PC que não é o do QR, mesmo que alguém no caminho o entregue no lugar do verdadeiro', async () => {
    const [real, impostor, phoneId] = [createIdentity('PC'), createIdentity('Impostor'), createIdentity('Celular')]
    const [phoneSide, impostorSide] = duplexPair()
    void openEnvelope(impostorSide, impostor, () => true).catch(() => {})
    await expect(sealEnvelope(phoneSide, phoneId, real.fingerprint)).rejects.toThrow('não é o do pareamento')
  })
})

describe('relay: quem entra', () => {
  it('só entra quem prova a chave de um aparelho registrado; assinatura boa de aparelho sem conta recebe 403', async () => {
    const [pcId, unknown] = [createIdentity('PC'), createIdentity('Sem conta')]
    const relay = await listen(createRelay({ directory: directory([pcId]) }))
    const path = `/s/${pcId.fingerprint}`
    expect(await upgrade(relay, path)).toBe(404)
    expect(await upgrade(relay, path, { authorization: 'Bearer qualquer-coisa' })).toBe(404)
    expect(await upgrade(relay, path, relayHeaders(pcId, path))).toBe(101)
    expect(await upgrade(relay, `/s/${unknown.fingerprint}`, relayHeaders(unknown, `/s/${unknown.fingerprint}`))).toBe(403)
  })

  it('ninguém fala em nome de outro PC: a assinatura do impostor no caminho do verdadeiro é recusada', async () => {
    const [real, impostor] = [createIdentity('PC'), createIdentity('Impostor')]
    const relay = await listen(createRelay({ directory: directory([real, impostor]) }))
    expect(await upgrade(relay, `/s/${real.fingerprint}`, relayHeaders(impostor, `/s/${real.fingerprint}`))).toBe(404)
    // Certificado do verdadeiro (público, qualquer um pode copiar) com a assinatura do impostor também não passa.
    const forged: Record<string, string> = { ...relayHeaders(impostor, `/s/${real.fingerprint}`), 'x-kora-certificate': relayHeaders(real, '/')['x-kora-certificate']! }
    forged.authorization = forged.authorization!.replace(impostor.fingerprint, real.fingerprint)
    expect(await upgrade(relay, `/s/${real.fingerprint}`, forged)).toBe(404)
    // Nem o certificado e a assinatura do próprio impostor, declarando a impressão digital do verdadeiro.
    const claimed = relayHeaders(impostor, `/s/${real.fingerprint}`)
    claimed.authorization = claimed.authorization!.replace(impostor.fingerprint, real.fingerprint)
    expect(await upgrade(relay, `/s/${real.fingerprint}`, claimed)).toBe(404)
  })

  it('soma as recusas por motivo e registra uma linha por intervalo, sem IP nem impressão digital', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const lines: string[] = []
    const relay = await listen(createRelay({ directory: directory([pcId], [[phoneId, pcId]]), log: (line) => lines.push(line), reportMs: 50 }))
    const phonePath = `/c/${pcId.fingerprint}`
    expect(await upgrade(relay, phonePath, relayHeaders(phoneId, phonePath))).toBe(404)
    expect(await upgrade(relay, phonePath, relayHeaders(phoneId, phonePath))).toBe(404)
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`)).toBe(404)
    // Com o CI lento as recusas podem cair em intervalos diferentes: o que vale é a soma das linhas.
    const totals = (): Record<string, number> => {
      const sum: Record<string, number> = {}
      for (const line of lines) {
        expect(line).toMatch(/^\[relay\] recusas: [a-z-]+=\d+( [a-z-]+=\d+)*$/)
        for (const [, reason, count] of line.matchAll(/([a-z-]+)=(\d+)/g)) sum[reason!] = (sum[reason!] ?? 0) + Number(count)
      }
      return sum
    }
    await expect.poll(totals).toEqual({ 'pc-fora-do-ar': 2, 'assinatura-invalida': 1 })
    expect(lines.join()).not.toContain(pcId.fingerprint.slice(0, 12))
  })

  it('a assinatura vale só para o caminho assinado e por 2 minutos', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ directory: directory([pcId]) }))
    const path = `/s/${pcId.fingerprint}`
    expect(await upgrade(relay, path, relayHeaders(pcId, `${path}/${'a'.repeat(32)}`))).toBe(404)
    expect(await upgrade(relay, path, relayHeaders(pcId, path, Date.now() - 3 * 60_000))).toBe(401)
    expect(await upgrade(relay, path, relayHeaders(pcId, path, Date.now() - 60_000))).toBe(101)
  })

  it('os mesmos cabeçalhos não abrem uma segunda conexão, mesmo dentro dos 2 minutos', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ directory: directory([pcId]) }))
    const path = `/s/${pcId.fingerprint}`
    const copied = relayHeaders(pcId, path)
    expect(await upgrade(relay, path, copied)).toBe(101)
    expect(await upgrade(relay, path, copied)).toBe(404)
    expect(await upgrade(relay, path, relayHeaders(pcId, path))).toBe(101)
  })

  it('relógio do aparelho fora da hora recebe 401 e não bloqueia o IP (que pode ser de muita gente)', async () => {
    const [late, other] = [createIdentity('PC atrasado'), createIdentity('Outro PC')]
    const relay = await listen(createRelay({ directory: directory([late, other]), maxFailures: 2, banMs: 60_000 }))
    for (let i = 0; i < 5; i++) expect(await upgrade(relay, `/s/${late.fingerprint}`, relayHeaders(late, `/s/${late.fingerprint}`, Date.now() + 10 * 60_000))).toBe(401)
    expect(await upgrade(relay, `/s/${other.fingerprint}`, relayHeaders(other, `/s/${other.fingerprint}`))).toBe(101)
  })

  it('celular só chega ao PC que o registrou; celular de outro PC recebe 403', async () => {
    const [pcA, pcB, phoneB] = [createIdentity('PC A'), createIdentity('PC B'), createIdentity('Celular de B')]
    const relay = await listen(createRelay({ directory: directory([pcA, pcB], [[phoneB, pcB]]) }))
    const { app, requests } = echoApp()
    pc(relay, pcA, () => true, app)
    await waitControl()
    expect(await upgrade(relay, `/c/${pcA.fingerprint}`, relayHeaders(phoneB, `/c/${pcA.fingerprint}`))).toBe(403)
    // Um PC também não entra como celular.
    expect(await upgrade(relay, `/c/${pcA.fingerprint}`, relayHeaders(pcB, `/c/${pcA.fingerprint}`))).toBe(403)
    expect(requests).toEqual([])
  })

  it('o mesmo celular pareado com dois PCs chega aos dois', async () => {
    const [home, work, phoneId] = [createIdentity('PC de casa'), createIdentity('PC do trabalho'), createIdentity('Celular')]
    const relay = await listen(createRelay({ directory: directory([home, work], [[phoneId, home], [phoneId, work]]) }))
    pc(relay, home, (fingerprint) => fingerprint === phoneId.fingerprint, echoApp().app)
    pc(relay, work, (fingerprint) => fingerprint === phoneId.fingerprint, echoApp().app)
    await waitControl()
    expect(await phoneRequest(relay, home.fingerprint, phoneId, 'casa')).toBe('eco: casa')
    expect(await phoneRequest(relay, work.fingerprint, phoneId, 'trabalho')).toBe('eco: trabalho')
  })

  it('celular que o PC ainda não informou só entra pela janela de pareamento (admit)', async () => {
    const [pcId, newcomer] = [createIdentity('PC'), createIdentity('Celular novo')]
    const dir = directory([pcId])
    let open = false
    const relay = await listen(createRelay({
      directory: { find: dir.find, admit: async (phone, pc) => (open && pc === pcId.fingerprint ? { accountId: ACCOUNT, kind: 'phone', pcs: [pc], blocked: false } : null) }
    }))
    pc(relay, pcId, () => true, echoApp().app)
    await waitControl()
    expect(await upgrade(relay, `/c/${pcId.fingerprint}`, relayHeaders(newcomer, `/c/${pcId.fingerprint}`))).toBe(403)
    open = true
    expect(await phoneRequest(relay, pcId.fingerprint, newcomer, 'parear')).toBe('eco: parear')
  })

  it('conta bloqueada: as conexões abertas caem na hora e as novas recebem 403', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const dir = directory([pcId], [[phoneId, pcId]])
    const server = createRelay({ directory: dir })
    const relay = await listen(server)
    const side = pc(relay, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, echoApp().app)
    await waitControl()
    const closed = new Promise((resolve) => side.control.on('close', resolve))
    for (const record of dir.map.values()) record.blocked = true
    server.dropAccount(ACCOUNT)
    await closed
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, relayHeaders(pcId, `/s/${pcId.fingerprint}`))).toBe(403)
  })

  it('banco fora do ar não derruba o relay: a conexão recebe 503 e ninguém é bloqueado', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ directory: { find: async () => { throw new Error('banco fora do ar') } }, maxFailures: 2, banMs: 60_000 }))
    for (let i = 0; i < 4; i++) expect(await upgrade(relay, `/s/${pcId.fingerprint}`, relayHeaders(pcId, `/s/${pcId.fingerprint}`))).toBe(503)
  })
})

describe('relay: o que ele mede e responde', () => {
  it('conta bytes e sessões por aparelho, nos dois sentidos, e anota IP e versão de quem chegou', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const usage = new Map<string, Required<UsageDelta>>()
    const seen: [string, { ip: string; client: string }][] = []
    const add = (fingerprint: string, delta: UsageDelta): void => {
      const total = usage.get(fingerprint) ?? { bytesIn: 0, bytesOut: 0, sessions: 0, seconds: 0 }
      for (const key of Object.keys(total) as (keyof UsageDelta)[]) total[key] += delta[key] ?? 0
      usage.set(fingerprint, total)
    }
    const relay = await listen(createRelay({ directory: directory([pcId], [[phoneId, pcId]]), usage: add, seen: (fingerprint, info) => { seen.push([fingerprint, info]) } }))
    const app = createHttpServer((req, res) => {
      req.resume()
      req.on('end', () => res.end(Buffer.alloc(200_000, 1)))
    })
    pc(relay, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    const ws = new WebSocket(`ws://127.0.0.1:${relay}/c/${pcId.fingerprint}`, { headers: { ...relayHeaders(phoneId, `/c/${pcId.fingerprint}`), 'x-kora-client': 'android/14 kora-android/0.5.0' } })
    closers.push(() => ws.terminate())
    const socket = await sealEnvelope(createWebSocketStream(ws), phoneId, pcId.fingerprint)
    await new Promise<void>((resolve, reject) => {
      request({ createConnection: () => socket, method: 'POST', path: '/', headers: { 'content-length': 50_000 } }, (res) => { res.resume(); res.on('end', resolve) }).on('error', reject).end(Buffer.alloc(50_000))
    })
    const phone = usage.get(phoneId.fingerprint)!
    const computer = usage.get(pcId.fingerprint)!
    expect(phone.sessions).toBe(1)
    expect(computer.sessions).toBe(1)
    expect(phone.bytesOut).toBeGreaterThan(50_000)
    expect(phone.bytesIn).toBeGreaterThan(200_000)
    // O que sai de um lado entra no outro: o relay não inventa nem perde bytes na conta.
    expect(computer.bytesIn).toBe(phone.bytesOut)
    expect(computer.bytesOut).toBe(phone.bytesIn)
    expect(seen).toContainEqual([phoneId.fingerprint, { ip: '127.0.0.1', client: 'android/14 kora-android/0.5.0' }])
  })

  it('o PC faz pedidos pela conexão de controle e recebe a resposta com o mesmo id; o relay sabe quem pediu', async () => {
    const pcId = createIdentity('PC')
    const asked: [Owner, unknown][] = []
    const relay = await listen(createRelay({
      directory: directory([pcId]),
      request: async (owner, body) => {
        asked.push([owner, body])
        if ((body as { op?: string }).op === 'falha') throw new Error('não deu')
        return { recebido: true }
      }
    }))
    const side = pc(relay, pcId, () => true, echoApp().app)
    await new Promise((resolve) => side.control.on('open', resolve))
    const replies: unknown[] = []
    side.control.on('message', (message) => { replies.push(JSON.parse(String(message))) })
    // JSON válido que não é objeto não derruba o relay (antes, "null" encerrava o processo de todo mundo).
    for (const strange of ['null', '5', '[]', '"texto"', '{"id":"x"}']) side.control.send(strange)
    side.control.send(JSON.stringify({ id: 7, op: 'celulares', lista: [] }))
    side.control.send(JSON.stringify({ id: 8, op: 'falha' }))
    await expect.poll(() => replies.length).toBe(2)
    expect(replies).toContainEqual({ id: 7, ok: true, result: { recebido: true } })
    expect(replies).toContainEqual({ id: 8, ok: false, error: 'não deu' })
    expect(asked[0]).toEqual([{ fingerprint: pcId.fingerprint, accountId: ACCOUNT }, { op: 'celulares', lista: [] }])
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

  it('responde 404 vazio a quem vasculha, e o health só no caminho secreto', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ directory: directory([pcId]), healthPath: '/saude-a8f3' }))
    for (const path of ['/', '/health', '/c', '/s/123', '/a/login']) expect(await status(relay, path)).toMatchObject({ code: 404, body: '' })
    expect(await upgrade(relay, `/c/${pcId.fingerprint}`)).toBe(404)
    const health = await status(relay, '/saude-a8f3')
    expect(health.code).toBe(200)
    expect(health.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(health.body)).toMatchObject({ started_at: expect.any(String), uptime_seconds: expect.any(Number) })
    expect(health.body.toLowerCase()).not.toContain('kora')
  })
})

describe('relay contra abuso', () => {
  it('bloqueia por um tempo quem erra demais, inclusive com a assinatura certa depois', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ directory: directory([pcId]), maxFailures: 3, banMs: 400 }))
    const path = `/s/${pcId.fingerprint}`
    for (let i = 0; i < 3; i++) expect(await upgrade(relay, path, { authorization: 'Kora chute' })).toBe(404)
    expect(await upgrade(relay, path, relayHeaders(pcId, path))).toBe(404)
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(await upgrade(relay, path, relayHeaders(pcId, path))).toBe(101)
  })

  it('celular procurando um PC desligado não é bloqueado, e entra quando o PC volta', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ directory: directory([pcId], [[phoneId, pcId]]), maxFailures: 3, banMs: 60_000 }))
    for (let i = 0; i < 6; i++) expect(await upgrade(relay, `/c/${pcId.fingerprint}`, relayHeaders(phoneId, `/c/${pcId.fingerprint}`))).toBe(404)
    const { app } = echoApp()
    pc(relay, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    expect(await phoneRequest(relay, pcId.fingerprint, phoneId, 'voltei')).toBe('eco: voltei')
  })

  it('aparelho sem conta insistindo não é bloqueado pelo IP: recebe 403 e quem divide a rede com ele segue entrando', async () => {
    const [pcId, removed] = [createIdentity('PC'), createIdentity('Removido')]
    const relay = await listen(createRelay({ directory: directory([pcId]), maxFailures: 3, banMs: 60_000 }))
    for (let i = 0; i < 6; i++) expect(await upgrade(relay, `/s/${removed.fingerprint}`, relayHeaders(removed, `/s/${removed.fingerprint}`))).toBe(403)
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, relayHeaders(pcId, `/s/${pcId.fingerprint}`))).toBe(101)
  })

  it('atrás do proxy, bloqueia o IP de quem pediu e não o do proxy; sem proxy, ignora o cabeçalho', async () => {
    const pcId = createIdentity('PC')
    const path = `/s/${pcId.fingerprint}`
    const behind = await listen(createRelay({ directory: directory([pcId]), trustProxy: true, maxFailures: 2, banMs: 60_000 }))
    const attacker = { 'x-forwarded-for': '203.0.113.9' }
    for (let i = 0; i < 2; i++) expect(await upgrade(behind, '/inventado', attacker)).toBe(404)
    expect(await upgrade(behind, path, { ...relayHeaders(pcId, path), ...attacker })).toBe(404)
    // O PC legítimo chega pelo mesmo proxy, com outro IP: segue entrando.
    expect(await upgrade(behind, path, { ...relayHeaders(pcId, path), 'x-forwarded-for': '198.51.100.4' })).toBe(101)
    // Quem forja o começo da lista não escapa: vale o último IP, o que o proxy acrescentou.
    expect(await upgrade(behind, path, { ...relayHeaders(pcId, path), 'x-forwarded-for': '198.51.100.4, 203.0.113.9' })).toBe(404)
    const direct = await listen(createRelay({ directory: directory([pcId]), maxFailures: 2, banMs: 60_000 }))
    for (let i = 0; i < 2; i++) expect(await upgrade(direct, '/inventado', { 'x-forwarded-for': '203.0.113.50' })).toBe(404)
    expect(await upgrade(direct, path, { ...relayHeaders(pcId, path), 'x-forwarded-for': '198.51.100.77' })).toBe(404)
  })
})

describe('relay com tráfego pesado e conexões ruins', () => {
  it('uma resposta de vários MB passa inteira, como um arquivo grande da tela', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ directory: directory([pcId], [[phoneId, pcId]]) }))
    const app = createHttpServer((_req, res) => res.end(Buffer.alloc(3 * 1024 * 1024, 7)))
    pc(relay, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    const socket = await sealEnvelope(createWebSocketStream(phoneSocket(relay, pcId.fingerprint, phoneId)), phoneId, pcId.fingerprint)
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
    const relay = await listen(createRelay({ directory: directory([pcId], [[phoneId, pcId]]), maxMessageBytes: 64 * 1024 }))
    const { app } = echoApp()
    pc(relay, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    await waitControl()
    const abusive = phoneSocket(relay, pcId.fingerprint, phoneId)
    abusive.on('error', () => {})
    await new Promise((resolve) => abusive.on('open', resolve))
    const closed = new Promise((resolve) => abusive.on('close', resolve))
    abusive.send(Buffer.alloc(200 * 1024))
    await closed
    expect(await phoneRequest(relay, pcId.fingerprint, phoneId, 'ainda de pé')).toBe('eco: ainda de pé')
  })

  it('o PC atrasado para uma sessão que já expirou não é bloqueado, mesmo muitas vezes', async () => {
    const pcId = createIdentity('PC')
    const relay = await listen(createRelay({ directory: directory([pcId]), maxFailures: 3, banMs: 60_000 }))
    for (let i = 0; i < 6; i++) {
      const path = `/s/${pcId.fingerprint}/${'0'.repeat(31)}${i}`
      expect(await upgrade(relay, path, relayHeaders(pcId, path))).toBe(404)
    }
    expect(await upgrade(relay, `/s/${pcId.fingerprint}`, relayHeaders(pcId, `/s/${pcId.fingerprint}`))).toBe(101)
  })
})

describe('relay com quem não lê', () => {
  it('o destino que para de ler derruba a sessão em vez de acumular memória na VPS', async () => {
    const [pcId, phoneId] = [createIdentity('PC'), createIdentity('Celular')]
    const relay = await listen(createRelay({ directory: directory([pcId], [[phoneId, pcId]]), maxBufferedBytes: 256 * 1024 }))
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
      pc(relay, pcId, (fingerprint) => fingerprint === phoneId.fingerprint, app)
    })
    await waitControl()
    const ws = phoneSocket(relay, pcId.fingerprint, phoneId)
    const socket = await sealEnvelope(createWebSocketStream(ws), phoneId, pcId.fingerprint)
    ;(ws as unknown as { _socket: { pause(): void } })._socket.pause()
    request({ createConnection: () => socket, path: '/' }, () => {}).on('error', () => {}).end()
    // Sem o teto, o relay guardaria os 256 MB na memória e a resposta terminaria; com ele, a sessão cai no meio.
    expect(await outcome).toBe('cortada')
  }, 30_000)
})
