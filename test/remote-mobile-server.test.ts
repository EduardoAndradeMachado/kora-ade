import { mkdtempSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, createWebSocketStream } from 'ws'
import { relayHeaders } from '../relay/auth'
import { createRelay, type DeviceRecord } from '../relay/relay'
import { createIdentity, type Identity } from '../src/main/remote/identity'
import { sealEnvelope } from '../src/main/remote/envelope'
import { MobileServer } from '../src/main/mobile-server'
import { MobileRuntime } from '../src/main/mobile-runtime'
import { Terminals } from '../src/main/terminals'
import { emptyState, type KoraState } from '../src/shared/state'

const CLIENT = 'windows/10.0.26100 kora/0.0.0'
const closers: (() => unknown)[] = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

async function setup(): Promise<{ server: MobileServer; relay: string; lan: string; pc: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kora-remoto-'))
  writeFileSync(join(dir, 'mobile.html'), '<html>Kora</html>')
  let state: KoraState = { ...emptyState(), projects: [{ id: 'p', name: 'Projeto', path: dir }] }
  const terminals = new Terminals({ onData: () => {}, onExit: () => {} })
  closers.push(() => terminals.killAll())
  const runtime = new MobileRuntime({ state: () => state, commit: (next) => { state = next }, terminals, activities: new Map(), launch: () => {}, changed: () => {}, sized: () => {} })
  const server = new MobileServer({ configFile: join(dir, 'mobile.json'), rendererDir: dir, runtime, changed: () => {}, port: 0 })
  closers.push(() => server.stop())
  closers.push(() => server.stopRemote())
  // Relay que guarda em memória o que o PC informa pelo pedido "sincronizar", como o serviço de verdade faz no banco:
  // se o MobileServer deixar de informar um celular ou a janela do QR, o celular não entra.
  const phones = new Map<string, string[]>()
  let pairingUntil = 0
  const pcFingerprint = (): string => server.pairing.identity().fingerprint
  const record = (kind: 'pc' | 'phone', pcs: string[]): DeviceRecord => ({ accountId: 'conta', kind, pcs, blocked: false })
  const relayServer: Server = createRelay({
    directory: {
      find: async (fingerprint) => (fingerprint === pcFingerprint() ? record('pc', []) : phones.has(fingerprint) ? record('phone', phones.get(fingerprint)!) : null),
      admit: async (phone, pc) => (pairingUntil > Date.now() && pc === pcFingerprint() ? (phones.set(phone, [pc]), record('phone', [pc])) : null)
    },
    request: async (_owner, body) => {
      const message = body as { op: string; celulares: { fingerprint: string }[]; pareamentoAte: number | null }
      if (message.op !== 'sincronizar') throw new Error('Pedido desconhecido.')
      phones.clear()
      for (const phone of message.celulares) phones.set(phone.fingerprint, [pcFingerprint()])
      pairingUntil = message.pareamentoAte ?? 0
      return { ok: true }
    }
  })
  await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => relayServer.close(resolve)))
  await server.start()
  const lan = `http://127.0.0.1:${(server as unknown as { port: number }).port}`
  return { server, relay: `ws://127.0.0.1:${(relayServer.address() as AddressInfo).port}`, lan, pc: server.pairing.identity().fingerprint }
}

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('a condição não aconteceu a tempo')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function envelope(relay: string, pc: string, phone: Identity): Promise<TLSSocket> {
  const ws = new WebSocket(`${relay}/c/${pc}`, { headers: relayHeaders(phone, `/c/${pc}`) })
  closers.push(() => ws.terminate())
  return sealEnvelope(createWebSocketStream(ws), phone, pc)
}

// Um pedido HTTP pelo envelope, como o app fará: sem cookie, com o Host da origem https da tela do app.
function ask(socket: TLSSocket, path: string, body?: unknown, keepAlive = false): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ createConnection: () => socket, method: text ? 'POST' : 'GET', path, headers: { host: 'kora.app', origin: 'https://kora.app', ...(keepAlive ? { connection: 'keep-alive' } : {}), ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}) } }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, json: data ? JSON.parse(data) as Record<string, unknown> : {} }))
    })
    req.on('error', reject)
    req.end(text)
  })
}

async function pairAtHome(server: MobileServer, lan: string, phone: Identity): Promise<string> {
  const { code } = server.pairing.invite()
  const paired = await fetch(`${lan}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Celular', certificado: phone.fingerprint }) })
  expect(paired.status).toBe(200)
  return server.pairing.devices.at(-1)!.id
}

describe('Fora de casa no servidor do celular', () => {
  it('o celular pareado em casa entra pelo relay com o mesmo pareamento, sem cookie', async () => {
    const { server, relay, lan, pc } = await setup()
    const phone = createIdentity('Celular')
    const device = await pairAtHome(server, lan, phone)
    server.startRemote(relay, CLIENT)
    await until(() => server.status().remote?.state === 'conectado')
    const state = await ask(await envelope(relay, pc, phone), '/api/state')
    expect(state.status).toBe(200)
    expect(state.json['deviceId']).toBe(device)
  })

  it('celular estranho não passa do aperto de mãos; com o QR valendo, pareia pelo próprio relay', async () => {
    const { server, relay, pc } = await setup()
    server.startRemote(relay, CLIENT)
    await until(() => server.status().remote?.state === 'conectado')
    const phone = createIdentity('Celular na rua')
    await expect(envelope(relay, pc, phone).then((socket) => ask(socket, '/api/state'))).rejects.toThrow()
    // O QR da tela, como o Kora gera: é ele que avisa o relay de que um celular novo pode chegar.
    const code = new URL((await server.invite()).url).hash.replace('#pair=', '')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const before = await ask(await envelope(relay, pc, phone), '/api/state')
    expect(before.status).toBe(401)
    expect((await ask(await envelope(relay, pc, phone), '/api/pair', { code, name: 'Celular na rua' })).status).toBe(200)
    // O QR já foi usado: o certificado registrado é o que deixa entrar daqui em diante.
    expect(server.pairing.pairingOpen).toBe(false)
    const after = await ask(await envelope(relay, pc, phone), '/api/state')
    expect(after.status).toBe(200)
    expect(after.json['deviceId']).toBe(server.pairing.deviceByCertificate(phone.fingerprint))
  })

  it('desligar a rede local não derruba quem está pelo relay; remover o celular derruba', async () => {
    const { server, relay, lan, pc } = await setup()
    const phone = createIdentity('Celular')
    const device = await pairAtHome(server, lan, phone)
    server.startRemote(relay, CLIENT)
    await until(() => server.status().remote?.state === 'conectado')
    await server.stop()
    expect(server.status().enabled).toBe(false)
    // A conexão fica aberta depois da resposta, como a do app: só a remoção do celular a fecha.
    const socket = await envelope(relay, pc, phone)
    expect((await ask(socket, '/api/state', undefined, true)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(socket.destroyed).toBe(false)
    const closed = new Promise((resolve) => socket.once('close', resolve))
    server.revoke(device)
    await closed
    await expect(envelope(relay, pc, phone).then((next) => ask(next, '/api/state'))).rejects.toThrow()
  })

  it('desligar Fora de casa fecha o link: o relay não acha mais o PC', async () => {
    const { server, relay, lan, pc } = await setup()
    const phone = createIdentity('Celular')
    await pairAtHome(server, lan, phone)
    server.startRemote(relay, CLIENT)
    await until(() => server.status().remote?.state === 'conectado')
    expect(server.stopRemote().remote).toBeNull()
    await expect(envelope(relay, pc, phone)).rejects.toThrow()
    // A rede local segue funcionando como antes.
    expect(server.status().enabled).toBe(true)
  })

  it('a identidade do PC é criada uma vez e continua a mesma depois de reabrir o Kora', async () => {
    const { server } = await setup()
    const first = server.pairing.identity()
    const reopened = new MobileServer({ configFile: (server.pairing as unknown as { file: string }).file, rendererDir: '.', runtime: null as never, changed: () => {} })
    expect(reopened.pairing.identity()).toEqual(first)
  })
})

describe('QR do pareamento', () => {
  it('pela rede local, leva o PC e o relay sem mudar o que o app atual lê; só com Fora de casa, aponta para o relay', async () => {
    const { server, relay, pc } = await setup()
    const home = new URL((await server.invite()).url)
    expect(home.protocol).toBe('http:')
    expect(home.searchParams.get('pc')).toBe(pc)
    expect(home.searchParams.get('relay')).toBeNull()
    // O app atual só lê host, porta e #pair=: continua igual.
    expect(home.hash).toMatch(/^#pair=[\w-]+$/)
    server.startRemote(relay, CLIENT)
    const both = new URL((await server.invite()).url)
    expect(both.searchParams.get('relay')).toBe(new URL(relay).host)
    await server.stop()
    const away = new URL((await server.invite()).url)
    expect(`${away.protocol}//${away.host}`).toBe(`https://${new URL(relay).host}`)
    expect(away.searchParams.get('pc')).toBe(pc)
    expect(away.hash).toMatch(/^#pair=[\w-]+$/)
    server.stopRemote()
    await expect(server.invite()).rejects.toThrow('Ative a conexão antes.')
  })
})

describe('celular que já estava pareado', () => {
  it('registra o certificado pelo pareamento de casa e passa a entrar pelo relay, sem ler outro QR', async () => {
    const { server, relay, lan, pc } = await setup()
    server.startRemote(relay, CLIENT)
    const health = await (await fetch(`${lan}/health`)).json() as Record<string, unknown>
    expect(health['pc']).toBe(pc)
    expect(health['relay']).toBe(new URL(relay).host)
    // Pareado pelo app antigo: sem certificado. O relay ainda não deixa entrar.
    const { code } = server.pairing.invite()
    const paired = await fetch(`${lan}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Celular de antes' }) })
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
    await until(() => server.status().remote?.state === 'conectado')
    const phone = createIdentity('Celular de antes')
    await expect(envelope(relay, pc, phone).then((socket) => ask(socket, '/api/state'))).rejects.toThrow()
    expect((await fetch(`${lan}/api/device/certificate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ certificado: phone.fingerprint }) })).status).toBe(401)
    expect((await fetch(`${lan}/api/device/certificate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ certificado: phone.fingerprint }) })).status).toBe(200)
    const state = await ask(await envelope(relay, pc, phone), '/api/state')
    expect(state.status).toBe(200)
    expect(state.json['deviceId']).toBe(server.pairing.devices[0]!.id)
  })
})

describe('o que só o celular dono do pareamento pode fazer', () => {
  it('pelo cookie da rede local, o certificado entra uma vez e não é trocado por outro', async () => {
    const { server, relay, lan, pc } = await setup()
    server.startRemote(relay, CLIENT)
    const { code } = server.pairing.invite()
    const paired = await fetch(`${lan}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Celular' }) })
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
    const register = (certificado: string): Promise<Response> => fetch(`${lan}/api/device/certificate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ certificado }) })
    const [phone, intruder] = [createIdentity('Celular'), createIdentity('Quem pegou o cookie')]
    expect((await register(phone.fingerprint)).status).toBe(200)
    expect((await register(phone.fingerprint)).status).toBe(200)
    expect((await register(intruder.fingerprint)).status).toBe(400)
    await until(() => server.status().remote?.state === 'conectado')
    expect((await ask(await envelope(relay, pc, phone), '/api/state')).status).toBe(200)
    await expect(envelope(relay, pc, intruder).then((socket) => ask(socket, '/api/state'))).rejects.toThrow()
  })

  it('o celular que se desvincula pelo relay recebe a resposta antes de o túnel cair', async () => {
    const { server, relay, lan, pc } = await setup()
    const phone = createIdentity('Celular')
    await pairAtHome(server, lan, phone)
    server.startRemote(relay, CLIENT)
    await until(() => server.status().remote?.state === 'conectado')
    const socket = await envelope(relay, pc, phone)
    const left = await new Promise<number>((resolve, reject) => {
      request({ createConnection: () => socket, method: 'DELETE', path: '/api/device', headers: { host: 'kora.app', origin: 'https://kora.app' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) }).on('error', reject).end()
    })
    expect(left).toBe(200)
    expect(server.pairing.devices).toEqual([])
  })
})
