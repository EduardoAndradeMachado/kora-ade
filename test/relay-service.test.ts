import { createServer as createHttpServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, createWebSocketStream } from 'ws'
import { Accounts } from '../relay/accounts'
import { relayHeaders } from '../relay/auth'
import { connect, migrate, type Sql } from '../relay/db'
import type { Email } from '../relay/emails'
import { createRelay, type Relay } from '../relay/relay'
import { RelayService } from '../relay/service'
import { startTestDatabase } from '../relay/testing/pg'
import { sealEnvelope } from '../src/main/remote/envelope'
import { createIdentity, type Identity } from '../src/main/remote/identity'
import { RelayLink } from '../src/main/remote/link'
import { accountClient } from '../src/main/remote/account'

let database: Awaited<ReturnType<typeof startTestDatabase>>
let sql: Sql
let sent: { to: string; email: Email }[]
let service: RelayService
let relay: Relay
let port: number
const closers: (() => void)[] = []

beforeAll(async () => {
  database = await startTestDatabase()
  sql = connect(database.url)
  await sql`create schema kora_sync`
  await migrate(sql)
}, 60_000)

afterAll(async () => {
  await sql.end()
  await database.close()
})

beforeEach(async () => {
  await sql`truncate kora_sync.accounts, kora_sync.admin_log cascade`
  sent = []
  const accounts = new Accounts(sql, { send: async (to, email) => { sent.push({ to, email }) } }, { codeSecret: 'segredo-de-teste', logoUrl: 'https://exemplo/logo.png' })
  service = new RelayService({ sql, accounts })
  relay = createRelay({ directory: service.directory, usage: service.usage, seen: service.seen, request: service.request, api: service.api })
  service.relay = relay
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  port = (relay.address() as AddressInfo).port
  closers.push(() => relay.close())
})

afterEach(() => { while (closers.length) closers.pop()!() })

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('a condição não aconteceu a tempo')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function api(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : {} }
}

const code = (to: string): string => {
  const match = /(\d{3}) (\d{3})/.exec(sent.filter((item) => item.to === to).at(-1)?.email.text ?? '')
  return match![1]! + match![2]!
}

// Conta verificada e o PC dela entrando com a prova da chave, como o Kora do PC faz.
async function accountWithPc(email: string, pc: Identity): Promise<void> {
  expect((await api('/a/cadastro', { email })).status).toBe(200)
  expect((await api('/a/verificar', { email, codigo: code(email), senha: 'senha-boa-123' })).status).toBe(200)
  const login = await api('/a/entrar', { email, senha: 'senha-boa-123', nome: 'PC de teste' }, { ...relayHeaders(pc, `/a/entrar/${email}`), 'x-kora-client': 'windows/10.0.26100 kora/0.1.34' })
  expect(login).toMatchObject({ status: 200, body: { ok: true } })
}

function pcLink(pc: Identity, accepts: (fingerprint: string) => boolean = () => true): RelayLink {
  const app: Server = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => res.end(`eco: ${body}`))
  })
  const link = new RelayLink({ url: `ws://127.0.0.1:${port}`, identity: pc, accepts, deliver: (socket) => app.emit('connection', socket), minDelayMs: 30, maxDelayMs: 100 })
  closers.push(() => link.stop())
  link.start()
  return link
}

async function phoneRequest(pc: Identity, phone: Identity, body: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/c/${pc.fingerprint}`, { headers: { ...relayHeaders(phone, `/c/${pc.fingerprint}`), 'x-kora-client': 'android/14 kora-android/0.5.0' } })
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

const phoneStatus = (pc: Identity, phone: Identity): Promise<number> => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/c/${pc.fingerprint}`, { headers: relayHeaders(phone, `/c/${pc.fingerprint}`) })
  ws.on('open', () => { ws.terminate(); resolve(101) })
  ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); ws.terminate() })
  ws.on('error', () => {})
})

describe('relay com contas de verdade (Postgres)', () => {
  it('cadastro, login com a chave do PC, celulares informados pelo PC, conversa e consumo gravado no banco', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    await accountWithPc('dono@exemplo.com', pc)
    const link = pcLink(pc)
    await until(() => link.status.state === 'conectado')
    expect(await link.request({ op: 'conta' })).toEqual({ email: 'dono@exemplo.com', admin: false })
    expect(await phoneStatus(pc, phone)).toBe(403)
    await link.request({ op: 'sincronizar', celulares: [{ fingerprint: phone.fingerprint, name: 'Celular do dono' }], pareamentoAte: null })
    expect(await phoneRequest(pc, phone, 'oi pelo relay')).toBe('eco: oi pelo relay')
    await service.flush()
    const devices = await sql<{ kind: string; name: string; platform: string | null; os_version: string | null; app_version: string | null; bytes_in: string; bytes_out: string; sessions: string; last_ip: string | null }[]>`
      select kind, name, platform, os_version, app_version, bytes_in, bytes_out, sessions, last_ip from kora_sync.devices order by kind`
    expect(devices).toEqual([
      expect.objectContaining({ kind: 'pc', name: 'PC de teste', platform: 'windows', os_version: '10.0.26100', app_version: 'kora/0.1.34', sessions: '1', last_ip: '127.0.0.1' }),
      expect.objectContaining({ kind: 'phone', name: 'Celular do dono', platform: 'android', os_version: '14', app_version: 'kora-android/0.5.0', sessions: '1' })
    ])
    expect(Number(devices[1]!.bytes_out)).toBeGreaterThan(0)
    const [daily] = await sql<{ total: string }[]>`select sum(bytes_in + bytes_out)::text as total from kora_sync.usage_daily`
    expect(Number(daily!.total)).toBeGreaterThan(0)
  })

  it('o Kora do PC cria a conta, confirma o código e entra pelo cliente de verdade; o erro chega pronto para a tela', async () => {
    const pc = createIdentity('PC')
    const client = accountClient(`ws://127.0.0.1:${port}`, () => pc, 'Notebook', 'windows/10.0.26100 kora/0.1.34')
    await client.send({ acao: 'cadastro', email: 'Novo@Exemplo.com' })
    await expect(client.send({ acao: 'verificar', email: 'novo@exemplo.com', codigo: '000000', senha: 'senha-boa-123' })).rejects.toThrow('Código incorreto ou vencido')
    await client.send({ acao: 'verificar', email: 'novo@exemplo.com', codigo: code('novo@exemplo.com'), senha: 'senha-boa-123' })
    await expect(client.send({ acao: 'entrar', email: 'novo@exemplo.com', senha: 'errada-errada' })).rejects.toThrow('E-mail ou senha incorretos.')
    expect(await client.send({ acao: 'entrar', email: 'NOVO@exemplo.com', senha: 'senha-boa-123' })).toEqual({ ok: true, admin: false })
    await service.flush()
    const [device] = await sql<{ kind: string; name: string; platform: string }[]>`select kind, name, platform from kora_sync.devices where fingerprint = ${pc.fingerprint}`
    expect(device).toEqual({ kind: 'pc', name: 'Notebook', platform: 'windows' })
    const offline = accountClient('ws://127.0.0.1:1', () => pc, 'Notebook', 'windows/1 kora/1')
    await expect(offline.send({ acao: 'cadastro', email: 'x@exemplo.com' })).rejects.toThrow('Confira a internet do PC')
  })

  it('login sem a prova da chave, ou com a assinatura de outro caminho, não registra o PC', async () => {
    const pc = createIdentity('PC')
    await api('/a/cadastro', { email: 'a@exemplo.com' })
    await api('/a/verificar', { email: 'a@exemplo.com', codigo: code('a@exemplo.com'), senha: 'senha-boa-123' })
    expect((await api('/a/entrar', { email: 'a@exemplo.com', senha: 'senha-boa-123' })).status).toBe(400)
    expect((await api('/a/entrar', { email: 'a@exemplo.com', senha: 'senha-boa-123' }, relayHeaders(pc, '/a/entrar/outro@exemplo.com'))).status).toBe(400)
    expect((await api('/a/entrar', { email: 'a@exemplo.com', senha: 'errada-errada' }, relayHeaders(pc, '/a/entrar/a@exemplo.com'))).body).toEqual({ erro: 'E-mail ou senha incorretos.' })
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from kora_sync.devices`
    expect(count!.n).toBe(0)
  })

  it('celular novo entra só com o QR aberto, fica registrado; desfeito o pareamento, sai do banco', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular novo')]
    await accountWithPc('b@exemplo.com', pc)
    const link = pcLink(pc)
    await until(() => link.status.state === 'conectado')
    expect(await phoneStatus(pc, phone)).toBe(403)
    await link.request({ op: 'sincronizar', celulares: [], pareamentoAte: Date.now() + 60_000 })
    expect(await phoneRequest(pc, phone, 'parear')).toBe('eco: parear')
    expect(await sql`select 1 from kora_sync.phone_pcs where phone = ${phone.fingerprint} and pc = ${pc.fingerprint}`).toHaveLength(1)
    await link.request({ op: 'sincronizar', celulares: [], pareamentoAte: null })
    expect(await sql`select 1 from kora_sync.devices where fingerprint = ${phone.fingerprint}`).toHaveLength(0)
    expect(await phoneStatus(pc, phone)).toBe(403)
  })

  it('a janela de pareamento não passa de 5 minutos, mesmo que o PC peça mais', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    await accountWithPc('c@exemplo.com', pc)
    let clock = Date.now()
    const accounts = new Accounts(sql, { send: async () => {} }, { codeSecret: 'x', logoUrl: 'https://x' })
    const timed = new RelayService({ sql, accounts, now: () => clock })
    const [account] = await sql<{ id: string }[]>`select id from kora_sync.accounts where email = 'c@exemplo.com'`
    await timed.request({ fingerprint: pc.fingerprint, accountId: account!.id }, { op: 'sincronizar', celulares: [], pareamentoAte: clock + 24 * 60 * 60_000 })
    clock += 5 * 60_000 + 1
    expect(await timed.directory.admit(phone.fingerprint, pc.fingerprint)).toBeNull()
  })

  it('PC não registra outro PC como celular dele, e celular de um PC não chega a outro', async () => {
    const [pcA, pcB, phoneB] = [createIdentity('PC A'), createIdentity('PC B'), createIdentity('Celular de B')]
    await accountWithPc('donoa@exemplo.com', pcA)
    await accountWithPc('donob@exemplo.com', pcB)
    const linkA = pcLink(pcA)
    const linkB = pcLink(pcB)
    await until(() => linkA.status.state === 'conectado' && linkB.status.state === 'conectado')
    await linkA.request({ op: 'sincronizar', celulares: [{ fingerprint: pcB.fingerprint, name: 'PC B disfarçado' }], pareamentoAte: null })
    // PC B continua PC e continua na conta do dono dele: A não o leva para a própria conta nem o liga como celular.
    const [owner] = await sql<{ kind: string; email: string }[]>`
      select d.kind, a.email from kora_sync.devices d join kora_sync.accounts a on a.id = d.account_id where d.fingerprint = ${pcB.fingerprint}`
    expect(owner).toEqual({ kind: 'pc', email: 'donob@exemplo.com' })
    expect(await sql`select 1 from kora_sync.phone_pcs where phone = ${pcB.fingerprint}`).toHaveLength(0)
    await linkB.request({ op: 'sincronizar', celulares: [{ fingerprint: phoneB.fingerprint, name: 'Celular de B' }], pareamentoAte: null })
    expect(await phoneStatus(pcA, phoneB)).toBe(403)
    expect(await phoneStatus(pcB, phoneB)).toBe(101)
  })

  it('admin: quem não é admin recebe "pedido desconhecido"; o admin vê contas e aparelhos e bloqueia na hora', async () => {
    const [adminPc, userPc, userPhone] = [createIdentity('PC do admin'), createIdentity('PC do usuário'), createIdentity('Celular do usuário')]
    await accountWithPc('admin@exemplo.com', adminPc)
    await accountWithPc('usuario@exemplo.com', userPc)
    const adminLink = pcLink(adminPc)
    const userLink = pcLink(userPc)
    await until(() => adminLink.status.state === 'conectado' && userLink.status.state === 'conectado')
    await expect(adminLink.request({ op: 'admin:visao' })).rejects.toThrow('Pedido desconhecido')
    await expect(userLink.request({ op: 'admin:bloquear', conta: 'qualquer' })).rejects.toThrow('Pedido desconhecido')
    // Só o banco faz alguém admin; o pedido seguinte já vale.
    await sql`update kora_sync.accounts set admin = true where email = 'admin@exemplo.com'`
    await userLink.request({ op: 'sincronizar', celulares: [{ fingerprint: userPhone.fingerprint, name: 'Celular do usuário' }], pareamentoAte: null })
    expect(await phoneRequest(userPc, userPhone, 'oi')).toBe('eco: oi')
    const view = await adminLink.request<{ accounts: { id: string; email: string }[]; devices: { fingerprint: string; kind: string; online: boolean; pcs: string[] }[] }>({ op: 'admin:visao' })
    expect(view.accounts.map((account) => account.email)).toEqual(['admin@exemplo.com', 'usuario@exemplo.com'])
    expect(view.devices.find((device) => device.fingerprint === userPc.fingerprint)).toMatchObject({ kind: 'pc', online: true })
    expect(view.devices.find((device) => device.fingerprint === userPhone.fingerprint)).toMatchObject({ kind: 'phone', pcs: [userPc.fingerprint] })
    const user = view.accounts.find((account) => account.email === 'usuario@exemplo.com')!
    const admin = view.accounts.find((account) => account.email === 'admin@exemplo.com')!
    await expect(adminLink.request({ op: 'admin:bloquear', conta: admin.id })).rejects.toThrow('própria conta')
    await adminLink.request({ op: 'admin:bloquear', conta: user.id, motivo: 'abuso' })
    await until(() => userLink.status.error?.includes('conta ativa') === true)
    // O PC bloqueado saiu do ar, então o celular dele não acha mais com quem falar.
    expect(await phoneStatus(userPc, userPhone)).toBe(404)
    const log = await sql<{ action: string; detail: { motivo: string } }[]>`select action, detail from kora_sync.admin_log`
    expect(log).toEqual([{ action: 'bloquear', detail: { motivo: 'abuso' } }])
    await adminLink.request({ op: 'admin:desbloquear', conta: user.id })
    await until(() => userLink.status.state === 'conectado', 8_000)
  })

  it('trocar a senha tira da conta todos os PCs que entraram com a senha antiga, na hora', async () => {
    const [mine, intruder] = [createIdentity('Meu PC'), createIdentity('PC de quem descobriu a senha')]
    await accountWithPc('h@exemplo.com', mine)
    const login = await api('/a/entrar', { email: 'h@exemplo.com', senha: 'senha-boa-123' }, relayHeaders(intruder, '/a/entrar/h@exemplo.com'))
    expect(login.status).toBe(200)
    const intruderLink = pcLink(intruder)
    await until(() => intruderLink.status.state === 'conectado')
    await api('/a/esqueci', { email: 'h@exemplo.com' })
    expect((await api('/a/redefinir', { email: 'h@exemplo.com', codigo: code('h@exemplo.com'), senha: 'outra-senha-boa' })).status).toBe(200)
    await until(() => intruderLink.status.error?.includes('conta ativa') === true)
    expect(await sql`select 1 from kora_sync.devices where kind = 'pc'`).toHaveLength(0)
    // Quem trocou a senha entra de novo com ela (o Kora faz isso sozinho depois de redefinir).
    expect((await api('/a/entrar', { email: 'h@exemplo.com', senha: 'outra-senha-boa' }, relayHeaders(mine, '/a/entrar/h@exemplo.com'))).status).toBe(200)
  })

  it('a impressão digital de um PC cadastrada antes como celular por outra conta volta para o dono quando ele entra', async () => {
    const [squatter, victim] = [createIdentity('PC de outra conta'), createIdentity('PC do dono')]
    await accountWithPc('outra@exemplo.com', squatter)
    const squatterLink = pcLink(squatter)
    await until(() => squatterLink.status.state === 'conectado')
    await squatterLink.request({ op: 'sincronizar', celulares: [{ fingerprint: victim.fingerprint, name: 'disfarce' }], pareamentoAte: null })
    await accountWithPc('dono@exemplo.com', victim)
    const [row] = await sql<{ kind: string; email: string }[]>`
      select d.kind, a.email from kora_sync.devices d join kora_sync.accounts a on a.id = d.account_id where d.fingerprint = ${victim.fingerprint}`
    expect(row).toEqual({ kind: 'pc', email: 'dono@exemplo.com' })
    expect(await sql`select 1 from kora_sync.phone_pcs where phone = ${victim.fingerprint}`).toHaveLength(0)
    const victimLink = pcLink(victim)
    await until(() => victimLink.status.state === 'conectado')
  })

  it('celular pareado com PCs de duas contas: bloquear uma não tira o acesso dele ao PC da outra', async () => {
    const [mine, friend, phone] = [createIdentity('Meu PC'), createIdentity('PC do amigo'), createIdentity('Celular')]
    await accountWithPc('eu@exemplo.com', mine)
    await accountWithPc('amigo@exemplo.com', friend)
    const myLink = pcLink(mine)
    const friendLink = pcLink(friend)
    await until(() => myLink.status.state === 'conectado' && friendLink.status.state === 'conectado')
    await myLink.request({ op: 'sincronizar', celulares: [{ fingerprint: phone.fingerprint, name: 'Celular' }], pareamentoAte: null })
    // O amigo sincroniza por último: o celular fica "na conta" dele.
    await friendLink.request({ op: 'sincronizar', celulares: [{ fingerprint: phone.fingerprint, name: 'Celular' }], pareamentoAte: null })
    await sql`update kora_sync.accounts set admin = true where email = 'eu@exemplo.com'`
    const [friendAccount] = await sql<{ id: string }[]>`select id from kora_sync.accounts where email = 'amigo@exemplo.com'`
    // Sessão aberta com o meu PC antes do bloqueio: ela é da minha conta e não pode cair junto com a do amigo.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/c/${mine.fingerprint}`, { headers: relayHeaders(phone, `/c/${mine.fingerprint}`) })
    closers.push(() => ws.terminate())
    const socket = await sealEnvelope(createWebSocketStream(ws), phone, mine.fingerprint)
    await myLink.request({ op: 'admin:bloquear', conta: friendAccount!.id })
    await until(() => friendLink.status.error?.includes('conta ativa') === true)
    const answer = await new Promise<string>((resolve, reject) => {
      request({ createConnection: () => socket, method: 'POST', path: '/', headers: { 'content-length': 11 } }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve(text))
      }).on('error', reject).end('ainda aqui!')
    })
    expect(answer).toBe('eco: ainda aqui!')
    expect(await phoneRequest(mine, phone, 'ainda chego')).toBe('eco: ainda chego')
  })

  it('login com o relógio do PC errado explica o motivo', async () => {
    const pc = createIdentity('PC')
    await api('/a/cadastro', { email: 'r@exemplo.com' })
    await api('/a/verificar', { email: 'r@exemplo.com', codigo: code('r@exemplo.com'), senha: 'senha-boa-123' })
    const login = await api('/a/entrar', { email: 'r@exemplo.com', senha: 'senha-boa-123' }, relayHeaders(pc, '/a/entrar/r@exemplo.com', Date.now() - 10 * 60_000))
    expect(login).toEqual({ status: 400, body: { erro: expect.stringContaining('data e a hora deste PC') } })
  })

  it('banco fora do ar: quem já entrou segue entrando pelo cache; aparelho novo recebe 503', async () => {
    const [pc, stranger] = [createIdentity('PC'), createIdentity('Novo')]
    await accountWithPc('d@exemplo.com', pc)
    expect(await service.directory.find(pc.fingerprint)).toMatchObject({ kind: 'pc', blocked: false })
    const broken = connect(database.url)
    await broken.end()
    ;(service as unknown as { sql: Sql }).sql = broken
    // Vencido o cache, a consulta falha e vale o que já se sabia.
    ;(service as unknown as { cache: Map<string, { at: number }> }).cache.get(pc.fingerprint)!.at = 0
    expect(await service.directory.find(pc.fingerprint)).toMatchObject({ kind: 'pc' })
    await expect(service.directory.find(stranger.fingerprint)).rejects.toThrow()
  })

  it('o que manda e-mail tem limite por IP', async () => {
    for (let i = 0; i < 5; i++) expect((await api('/a/cadastro', { email: `limite${i}@exemplo.com` })).status).toBe(200)
    expect(await api('/a/cadastro', { email: 'limite9@exemplo.com' })).toMatchObject({ status: 429 })
    expect(sent).toHaveLength(5)
  })

  it('o histórico diário some depois de 90 dias e o total acumulado do aparelho fica', async () => {
    const pc = createIdentity('PC')
    await accountWithPc('e@exemplo.com', pc)
    service.usage(pc.fingerprint, { bytesIn: 1000 })
    await service.flush()
    await sql`insert into kora_sync.usage_daily (fingerprint, day, bytes_in) values (${pc.fingerprint}, (now() at time zone 'utc')::date - 91, 5)`
    await service.prune()
    const days = await sql<{ bytes_in: string }[]>`select bytes_in from kora_sync.usage_daily`
    expect(days.map((day) => day.bytes_in)).toEqual(['1000'])
    const [device] = await sql<{ bytes_in: string }[]>`select bytes_in from kora_sync.devices`
    expect(device!.bytes_in).toBe('1000')
  })

  it('sair desliga o PC da conta e leva junto os celulares que só ele tinha', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    await accountWithPc('f@exemplo.com', pc)
    const link = pcLink(pc)
    await until(() => link.status.state === 'conectado')
    await link.request({ op: 'sincronizar', celulares: [{ fingerprint: phone.fingerprint, name: 'Celular' }], pareamentoAte: null })
    await link.request({ op: 'sair' })
    expect(await sql`select 1 from kora_sync.devices`).toHaveLength(0)
  })

  it('sair pelo Kora vale mesmo com o Fora de casa desligado, e só o próprio PC (assinado) se tira da conta', async () => {
    const [pc, other] = [createIdentity('PC'), createIdentity('Outro')]
    await accountWithPc('s@exemplo.com', pc)
    expect((await api('/a/sair', {}, relayHeaders(other, '/a/entrar/s@exemplo.com'))).status).toBe(400)
    expect((await api('/a/sair', {})).status).toBe(400)
    expect(await sql`select 1 from kora_sync.devices where fingerprint = ${pc.fingerprint}`).toHaveLength(1)
    await accountClient(`ws://127.0.0.1:${port}`, () => pc, 'Notebook', 'windows/1 kora/1').signOut()
    expect(await sql`select 1 from kora_sync.devices where fingerprint = ${pc.fingerprint}`).toHaveLength(0)
  })

  it('lista de celulares ausente ou de outro tipo é recusada e não apaga os vínculos que já existem', async () => {
    const [pc, phone] = [createIdentity('PC'), createIdentity('Celular')]
    await accountWithPc('l@exemplo.com', pc)
    const link = pcLink(pc)
    await until(() => link.status.state === 'conectado')
    await link.request({ op: 'sincronizar', celulares: [{ fingerprint: phone.fingerprint, name: 'Celular' }], pareamentoAte: null })
    for (const celulares of [null, undefined, 'x', 5]) await expect(link.request({ op: 'sincronizar', celulares, pareamentoAte: null })).rejects.toThrow('inválida')
    expect(await sql`select 1 from kora_sync.phone_pcs where phone = ${phone.fingerprint}`).toHaveLength(1)
  })

  it('bloqueio e auditoria vão juntos: se a auditoria falha, a conta não fica bloqueada pela metade', async () => {
    const [adminPc, userPc] = [createIdentity('PC do admin'), createIdentity('PC do usuário')]
    await accountWithPc('admin2@exemplo.com', adminPc)
    await accountWithPc('usuario2@exemplo.com', userPc)
    await sql`update kora_sync.accounts set admin = true where email = 'admin2@exemplo.com'`
    const adminLink = pcLink(adminPc)
    await until(() => adminLink.status.state === 'conectado')
    const [user] = await sql<{ id: string }[]>`select id from kora_sync.accounts where email = 'usuario2@exemplo.com'`
    await sql`alter table kora_sync.admin_log rename to admin_log_fora`
    try {
      await expect(adminLink.request({ op: 'admin:bloquear', conta: user!.id })).rejects.toThrow()
    } finally {
      await sql`alter table kora_sync.admin_log_fora rename to admin_log`
    }
    const [row] = await sql<{ blocked: boolean }[]>`select blocked_at is not null as blocked from kora_sync.accounts where id = ${user!.id}`
    expect(row!.blocked).toBe(false)
  })

  it('o painel não conta em dobro o consumo do celular pareado com dois PCs', async () => {
    const [home, work, phone] = [createIdentity('Casa'), createIdentity('Trabalho'), createIdentity('Celular')]
    await accountWithPc('p@exemplo.com', home)
    await accountWithPc('p2@exemplo.com', work)
    await sql`update kora_sync.accounts set admin = true where email = 'p@exemplo.com'`
    const homeLink = pcLink(home)
    const workLink = pcLink(work)
    await until(() => homeLink.status.state === 'conectado' && workLink.status.state === 'conectado')
    for (const link of [homeLink, workLink]) await link.request({ op: 'sincronizar', celulares: [{ fingerprint: phone.fingerprint, name: 'Celular' }], pareamentoAte: null })
    service.usage(phone.fingerprint, { bytesIn: 123, sessions: 2 })
    const view = await homeLink.request<{ devices: { fingerprint: string; bytes_in_30d: string; sessions_30d: string; pcs: string[] }[] }>({ op: 'admin:visao' })
    const seen = view.devices.find((device) => device.fingerprint === phone.fingerprint)!
    expect({ bytes: seen.bytes_in_30d, sessions: seen.sessions_30d, pcs: seen.pcs.length }).toEqual({ bytes: '123', sessions: '2', pcs: 2 })
  })

  it('consumo que não conseguiu ir ao banco volta para a fila e entra na gravação seguinte', async () => {
    const pc = createIdentity('PC')
    await accountWithPc('g@exemplo.com', pc)
    service.usage(pc.fingerprint, { bytesIn: 700 })
    const healthy = (service as unknown as { sql: Sql }).sql
    const broken = connect(database.url)
    await broken.end()
    ;(service as unknown as { sql: Sql }).sql = broken
    await expect(service.flush()).rejects.toThrow()
    ;(service as unknown as { sql: Sql }).sql = healthy
    service.usage(pc.fingerprint, { bytesIn: 300 })
    await service.flush()
    const [device] = await sql<{ bytes_in: string }[]>`select bytes_in from kora_sync.devices`
    expect(device!.bytes_in).toBe('1000')
  })
})
