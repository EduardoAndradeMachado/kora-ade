import type { IncomingMessage, ServerResponse } from 'node:http'
import { Accounts, normalizeEmail, passwordProblem } from './accounts.ts'
import { checkRelayAuth, parseRelayAuth } from './auth.ts'
import type { Sql } from './db.ts'
import type { DeviceRecord, Owner, Relay, UsageDelta } from './relay.ts'

// O que o relay sabe de contas e aparelhos, guardado no Postgres. O caminho quente (cada conexão, cada mensagem) não
// espera o banco: o diretório tem cache, e consumo e "visto por último" acumulam em memória e vão ao banco por minuto.

const CACHE_MS = 60_000
const PAIRING_MAX_MS = 5 * 60_000
const MAX_PHONES = 20
const RETENTION_DAYS = 90
const BODY_BYTES = 8 * 1024
// Por IP, em 10 minutos: o que manda e-mail é mais caro (e serve para encher a caixa de alguém).
const LIMITS = { email: 5, auth: 30 }
const LIMIT_WINDOW_MS = 10 * 60_000
const FINGERPRINT = /^[0-9a-f]{64}$/
// "windows/10.0.26100 kora/0.1.34", "android/14 kora-android/0.5.0"
const CLIENT = /^([a-z]+)\/([\w.-]{1,40}) ([\w-]{1,30}\/[\w.-]{1,30})$/

export interface ServiceOptions {
  sql: Sql
  accounts: Accounts
  now?: () => number
}

type Totals = Required<UsageDelta>
const emptyTotals = (): Totals => ({ bytesIn: 0, bytesOut: 0, sessions: 0, seconds: 0 })

export class RelayService {
  relay: Relay | null = null
  private readonly sql: Sql
  private readonly accounts: Accounts
  private readonly now: () => number
  private readonly cache = new Map<string, { record: DeviceRecord | null; at: number }>()
  private readonly pairing = new Map<string, { until: number; accountId: string }>()
  private usageQueue = new Map<string, Totals>()
  private seenQueue = new Map<string, { ip: string; client: string }>()
  private readonly lastSeen = new Map<string, { ip: string; client: string; at: number }>()
  private readonly limits = new Map<string, { count: number; since: number }>()
  private timers: NodeJS.Timeout[] = []

  constructor(options: ServiceOptions) {
    this.sql = options.sql
    this.accounts = options.accounts
    this.now = options.now ?? Date.now
  }

  start(): void {
    this.timers.push(setInterval(() => void this.flush().catch((error) => console.error('[relay] gravar consumo', error)), 60_000))
    this.timers.push(setInterval(() => void this.prune().catch((error) => console.error('[relay] limpar histórico', error)), 6 * 60 * 60_000))
    this.timers.push(setInterval(() => this.sweep(), 10 * 60_000))
    for (const timer of this.timers) timer.unref()
  }

  // Limites por IP e por conta de quem já passou da janela: sem isso o mapa só cresce com IPs novos.
  sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.limits) if (now - entry.since >= LIMIT_WINDOW_MS) this.limits.delete(key)
    this.accounts.sweep()
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    await this.flush().catch(() => {})
  }

  // --- diretório ---------------------------------------------------------------------------------------------------

  readonly directory = {
    find: (fingerprint: string): Promise<DeviceRecord | null> => this.find(fingerprint),
    admit: (phone: string, pc: string): Promise<DeviceRecord | null> => this.admit(phone, pc)
  }

  // Banco fora do ar: quem já foi visto continua entrando com o que o cache sabe; aparelho novo recebe 503.
  private async find(fingerprint: string): Promise<DeviceRecord | null> {
    const cached = this.cache.get(fingerprint)
    if (cached && this.now() - cached.at < CACHE_MS) return cached.record
    try {
      const [row] = await this.sql<{ account_id: string; kind: 'pc' | 'phone'; blocked: boolean; pcs: string[] }[]>`
        select d.account_id, d.kind, a.blocked_at is not null as blocked,
               coalesce(array_agg(l.pc) filter (where l.pc is not null), '{}') as pcs
        from kora_sync.devices d
        join kora_sync.accounts a on a.id = d.account_id
        left join kora_sync.phone_pcs l on l.phone = d.fingerprint
        where d.fingerprint = ${fingerprint}
        group by d.account_id, d.kind, a.blocked_at`
      // Celular não tem bloqueio próprio: quem decide é a conta do PC que ele procura (o relay derruba por ela).
      const record = row ? { accountId: row.account_id, kind: row.kind, pcs: row.pcs, blocked: row.kind === 'pc' && row.blocked } : null
      this.cache.set(fingerprint, { record, at: this.now() })
      return record
    } catch (error) {
      if (cached) return cached.record
      throw error
    }
  }

  private async admit(phone: string, pc: string): Promise<DeviceRecord | null> {
    const window = this.pairing.get(pc)
    if (!window || window.until < this.now()) return null
    const [pcRow] = await this.sql<{ kind: string }[]>`select kind from kora_sync.devices where fingerprint = ${phone}`
    if (pcRow && pcRow.kind !== 'phone') return null
    await this.sql.begin(async (tx) => {
      await tx`
        insert into kora_sync.devices (fingerprint, account_id, kind) values (${phone}, ${window.accountId}, 'phone')
        on conflict (fingerprint) do update set account_id = excluded.account_id`
      await tx`insert into kora_sync.phone_pcs (phone, pc) values (${phone}, ${pc}) on conflict do nothing`
    })
    this.cache.delete(phone)
    return this.find(phone)
  }

  // --- consumo -----------------------------------------------------------------------------------------------------

  readonly usage = (fingerprint: string, delta: UsageDelta): void => {
    const totals = this.usageQueue.get(fingerprint) ?? emptyTotals()
    totals.bytesIn += delta.bytesIn ?? 0
    totals.bytesOut += delta.bytesOut ?? 0
    totals.sessions += delta.sessions ?? 0
    totals.seconds += delta.seconds ?? 0
    this.usageQueue.set(fingerprint, totals)
  }

  // O celular abre uma conexão por pedido: só anota de novo quando muda o IP ou a versão, ou depois de um minuto.
  readonly seen = (fingerprint: string, given: { ip: string; client: string }): void => {
    const last = this.lastSeen.get(fingerprint)
    // Conexão sem X-Kora-Client não apaga o sistema e a versão que outra conexão já informou.
    const info = { ip: given.ip, client: given.client || last?.client || '' }
    if (last && last.ip === info.ip && last.client === info.client && this.now() - last.at < 60_000) return
    this.lastSeen.set(fingerprint, { ...info, at: this.now() })
    this.seenQueue.set(fingerprint, info)
  }

  // Falhou ao gravar: o que estava na fila volta para ela, somado ao que chegou no meio tempo.
  async flush(): Promise<void> {
    const usage = this.usageQueue
    const seen = this.seenQueue
    this.usageQueue = new Map()
    this.seenQueue = new Map()
    try {
      for (const [fingerprint, totals] of usage) {
        // Os dois juntos: se o segundo falhar e a fila voltar, o primeiro não pode ter ficado gravado.
        await this.sql.begin(async (tx) => {
        await tx`
          insert into kora_sync.usage_daily (fingerprint, day, bytes_in, bytes_out, sessions, connected_seconds)
          select ${fingerprint}, (now() at time zone 'utc')::date, ${totals.bytesIn}, ${totals.bytesOut}, ${totals.sessions}, ${totals.seconds}
          where exists (select 1 from kora_sync.devices where fingerprint = ${fingerprint})
          on conflict (fingerprint, day) do update set
            bytes_in = kora_sync.usage_daily.bytes_in + excluded.bytes_in,
            bytes_out = kora_sync.usage_daily.bytes_out + excluded.bytes_out,
            sessions = kora_sync.usage_daily.sessions + excluded.sessions,
            connected_seconds = kora_sync.usage_daily.connected_seconds + excluded.connected_seconds`
        await tx`
          update kora_sync.devices set
            bytes_in = bytes_in + ${totals.bytesIn}, bytes_out = bytes_out + ${totals.bytesOut},
            sessions = sessions + ${totals.sessions}, connected_seconds = connected_seconds + ${totals.seconds}
          where fingerprint = ${fingerprint}`
        })
        usage.delete(fingerprint)
      }
      for (const [fingerprint, info] of seen) {
        const client = CLIENT.exec(info.client)
        await this.sql`
          update kora_sync.devices set last_seen_at = now(), last_ip = ${info.ip},
            platform = coalesce(${client?.[1] ?? null}, platform), os_version = coalesce(${client?.[2] ?? null}, os_version),
            app_version = coalesce(${client?.[3] ?? null}, app_version)
          where fingerprint = ${fingerprint}`
        seen.delete(fingerprint)
      }
    } finally {
      for (const [fingerprint, totals] of usage) this.usage(fingerprint, totals)
      for (const [fingerprint, info] of seen) if (!this.seenQueue.has(fingerprint)) this.seenQueue.set(fingerprint, info)
    }
  }

  // Histórico diário só dos últimos 90 dias; o total acumulado fica no aparelho.
  async prune(): Promise<void> {
    await this.sql`delete from kora_sync.usage_daily where day < (now() at time zone 'utc')::date - ${RETENTION_DAYS}::int`
  }

  // --- pedidos do PC pela conexão de controle ------------------------------------------------------------------------

  readonly request = async (owner: Owner, body: unknown): Promise<unknown> => {
    const message = (body ?? {}) as Record<string, unknown>
    switch (message['op']) {
      case 'sincronizar': return this.sync(owner, message)
      case 'conta': return this.account(owner)
      case 'sair': return this.leave(owner.fingerprint)
      default:
        if (typeof message['op'] === 'string' && message['op'].startsWith('admin:') && (await this.isAdmin(owner))) return this.admin(owner, message)
        // Quem não é admin recebe a mesma resposta de um pedido que não existe.
        throw new Error('Pedido desconhecido.')
    }
  }

  private async sync(owner: Owner, message: Record<string, unknown>): Promise<{ ok: true }> {
    // Lista ausente ou de outro tipo é erro, não "nenhum celular": tratar como vazia apagaria os vínculos do PC.
    if (!Array.isArray(message['celulares'])) throw new Error('Lista de celulares inválida.')
    const list: unknown[] = message['celulares']
    const phones = list
      .filter((item): item is { fingerprint: string; name?: unknown } => typeof item === 'object' && item !== null && FINGERPRINT.test(String((item as { fingerprint?: unknown }).fingerprint)))
      .slice(0, MAX_PHONES)
      .map((item) => ({ fingerprint: item.fingerprint, name: typeof item.name === 'string' ? item.name.slice(0, 60) : null }))
    const until = typeof message['pareamentoAte'] === 'number' ? Math.min(message['pareamentoAte'], this.now() + PAIRING_MAX_MS) : 0
    if (until > this.now()) this.pairing.set(owner.fingerprint, { until, accountId: owner.accountId })
    else this.pairing.delete(owner.fingerprint)
    const keep = phones.map((phone) => phone.fingerprint)
    const touched = await this.sql.begin(async (tx) => {
      for (const phone of phones) {
        // Uma impressão digital de PC nunca vira celular, e o celular fica na conta de quem o registrou primeiro: outro
        // PC que conheça a impressão digital dele não o leva para a própria conta (consumo, painel).
        const [row] = await tx<{ kind: string }[]>`
          insert into kora_sync.devices (fingerprint, account_id, kind, name) values (${phone.fingerprint}, ${owner.accountId}, 'phone', ${phone.name})
          on conflict (fingerprint) do update set name = coalesce(excluded.name, kora_sync.devices.name)
          where kora_sync.devices.kind = 'phone'
          returning kind`
        if (row) await tx`insert into kora_sync.phone_pcs (phone, pc) values (${phone.fingerprint}, ${owner.fingerprint}) on conflict do nothing`
      }
      const dropped = await tx<{ phone: string }[]>`
        delete from kora_sync.phone_pcs where pc = ${owner.fingerprint} and not (phone = any(${keep}::text[])) returning phone`
      // Celular que ficou sem nenhum PC sai do banco (com o histórico dele).
      await tx`delete from kora_sync.devices d where d.kind = 'phone' and not exists (select 1 from kora_sync.phone_pcs l where l.phone = d.fingerprint)`
      return [...keep, ...dropped.map((row) => row.phone)]
    })
    for (const fingerprint of touched) this.cache.delete(fingerprint)
    return { ok: true }
  }

  private async account(owner: Owner): Promise<{ email: string; admin: boolean }> {
    const [row] = await this.sql<{ email: string; admin: boolean }[]>`select email, admin from kora_sync.accounts where id = ${owner.accountId}`
    if (!row) throw new Error('Conta não encontrada.')
    return { email: row.email, admin: row.admin }
  }

  private async signOutEverywhere(accountId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`delete from kora_sync.devices where account_id = ${accountId} and kind = 'pc'`
      await tx`delete from kora_sync.devices d where d.kind = 'phone' and not exists (select 1 from kora_sync.phone_pcs l where l.phone = d.fingerprint)`
    })
    this.cache.clear()
    this.relay?.dropAccount(accountId)
  }

  private async leave(fingerprint: string): Promise<{ ok: true }> {
    await this.sql.begin(async (tx) => {
      await tx`delete from kora_sync.devices where fingerprint = ${fingerprint} and kind = 'pc'`
      await tx`delete from kora_sync.devices d where d.kind = 'phone' and not exists (select 1 from kora_sync.phone_pcs l where l.phone = d.fingerprint)`
    })
    this.cache.clear()
    this.pairing.delete(fingerprint)
    return { ok: true }
  }

  // --- admin ---------------------------------------------------------------------------------------------------------

  // Sempre do banco, nunca do cache: tirar o admin de alguém vale no pedido seguinte.
  private async isAdmin(owner: Owner): Promise<boolean> {
    const [row] = await this.sql<{ admin: boolean }[]>`
      select a.admin from kora_sync.accounts a join kora_sync.devices d on d.account_id = a.id
      where a.id = ${owner.accountId} and d.fingerprint = ${owner.fingerprint} and d.kind = 'pc' and a.blocked_at is null`
    return row?.admin === true
  }

  private async admin(owner: Owner, message: Record<string, unknown>): Promise<unknown> {
    const target = typeof message['conta'] === 'string' ? message['conta'] : ''
    switch (message['op']) {
      case 'admin:visao': return this.overview(owner)
      case 'admin:bloquear':
      case 'admin:desbloquear': {
        if (target === owner.accountId) throw new Error('Você não pode bloquear a própria conta.')
        const block = message['op'] === 'admin:bloquear'
        const reason = typeof message['motivo'] === 'string' ? message['motivo'].slice(0, 200) : null
        // Bloqueio e auditoria juntos: ou os dois ficam gravados, ou nenhum.
        const found = await this.sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            update kora_sync.accounts set blocked_at = ${block ? new Date(this.now()) : null}, blocked_reason = ${block ? reason : null}
            where id = ${target} returning id`
          if (!row) return false
          await tx`insert into kora_sync.admin_log (admin_id, action, account_id, detail) values (${owner.accountId}, ${block ? 'bloquear' : 'desbloquear'}, ${target}, ${tx.json({ motivo: reason })})`
          return true
        })
        if (!found) throw new Error('Conta não encontrada.')
        this.cache.clear()
        if (block) this.relay?.dropAccount(target)
        return { ok: true }
      }
      default: throw new Error('Pedido desconhecido.')
    }
  }

  private async overview(owner: Owner): Promise<unknown> {
    // O painel mostra o "visto por último" e o consumo de agora, não o do último minuto gravado.
    await this.flush().catch(() => {})
    const accounts = await this.sql`
      select id, email, admin, created_at, verified_at, blocked_at, blocked_reason, last_login_at
      from kora_sync.accounts order by created_at`
    const devices = await this.sql`
      select d.fingerprint, d.account_id, d.kind, d.name, d.platform, d.os_version, d.app_version, d.created_at,
             d.last_seen_at, d.last_ip, d.bytes_in, d.bytes_out, d.sessions, d.connected_seconds,
             coalesce(u.bytes_in, 0)::bigint as bytes_in_30d, coalesce(u.bytes_out, 0)::bigint as bytes_out_30d,
             coalesce(u.sessions, 0)::bigint as sessions_30d, coalesce(l.pcs, '{}') as pcs
      from kora_sync.devices d
      -- Cada soma num subselect: juntar os dias e os PCs do celular na mesma consulta multiplicaria o consumo.
      left join (
        select fingerprint, sum(bytes_in) as bytes_in, sum(bytes_out) as bytes_out, sum(sessions) as sessions
        from kora_sync.usage_daily where day >= (now() at time zone 'utc')::date - 29 group by fingerprint
      ) u on u.fingerprint = d.fingerprint
      left join (select phone, array_agg(pc) as pcs from kora_sync.phone_pcs group by phone) l on l.phone = d.fingerprint
      order by d.created_at`
    const online = this.relay?.online() ?? new Set<string>()
    return {
      you: owner.accountId,
      accounts: accounts.map((account) => ({ ...account })),
      devices: devices.map((device) => ({ ...device, online: online.has(device['fingerprint'] as string) }))
    }
  }

  // --- API de conta (/a/...) -----------------------------------------------------------------------------------------

  readonly api = (request: IncomingMessage, response: ServerResponse, ip: string): void => {
    void this.handleApi(request, response, ip).catch((error) => {
      console.error('[relay] api', error)
      if (!response.headersSent) reply(response, 503, { erro: 'O servidor do Kora está com problema. Tente de novo em alguns minutos.' })
    })
  }

  private allowed(ip: string, kind: keyof typeof LIMITS): boolean {
    const key = `${kind}:${ip}`
    const now = this.now()
    const entry = this.limits.get(key)
    const current = entry && now - entry.since < LIMIT_WINDOW_MS ? entry : { count: 0, since: now }
    current.count++
    this.limits.set(key, current)
    return current.count <= LIMITS[kind]
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, ip: string): Promise<void> {
    const route = (request.url ?? '').split('?')[0]
    const routes: Record<string, keyof typeof LIMITS> = { '/a/cadastro': 'email', '/a/esqueci': 'email', '/a/verificar': 'auth', '/a/redefinir': 'auth', '/a/entrar': 'auth', '/a/sair': 'auth' }
    const kind = route ? routes[route] : undefined
    if (request.method !== 'POST' || !kind) return void response.writeHead(404, { 'content-length': '0' }).end()
    if (!this.allowed(ip, kind)) return reply(response, 429, { erro: 'Muitas tentativas deste endereço. Espere alguns minutos.' })
    const body = await readJson(request)
    if (!body) return reply(response, 400, { erro: 'Pedido inválido.' })
    const text = (key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : '')
    const email = text('email')
    if (route === '/a/sair') {
      // Sair prova a chave do PC, como o login: só o próprio PC se tira da conta.
      const auth = parseRelayAuth(request.headers.authorization, request.headers['x-kora-certificate'] as string | undefined)
      const checked = auth ? checkRelayAuth(auth, '/a/sair', this.now()) : 'invalid'
      if (checked === 'stale') return reply(response, 400, { erro: 'A data e a hora deste PC estão erradas. Ligue o ajuste automático nas configurações do Windows.' })
      if (!auth || checked !== 'ok') return reply(response, 400, { erro: 'Pedido inválido.' })
      await this.leave(auth.fingerprint)
      this.relay?.dropDevice(auth.fingerprint)
      return reply(response, 200, { ok: true })
    }
    if (route !== '/a/entrar' && !normalizeEmail(email)) return reply(response, 400, { erro: 'Confira o e-mail.' })

    switch (route) {
      case '/a/cadastro':
        await this.accounts.signup(email)
        return reply(response, 200, { ok: true })
      case '/a/esqueci':
        await this.accounts.requestReset(email)
        return reply(response, 200, { ok: true })
      case '/a/verificar':
      case '/a/redefinir': {
        const password = text('senha')
        const problem = passwordProblem(password)
        if (problem) return reply(response, 400, { erro: problem })
        const result = route === '/a/verificar'
          ? await this.accounts.verifySignup(email, text('codigo'), password)
          : await this.accounts.confirmReset(email, text('codigo'), password)
        if (!result.ok) return reply(response, 400, { erro: 'Código incorreto ou vencido. Peça outro.' })
        // Senha trocada: todo PC que entrou com a senha antiga sai da conta e cai na hora; quem trocou entra de novo.
        if (route === '/a/redefinir') await this.signOutEverywhere(result.accountId)
        return reply(response, 200, { ok: true })
      }
      case '/a/entrar': {
        // O login prova a posse da chave do PC (a mesma assinatura das conexões, sobre o caminho com o e-mail): só quem
        // tem a chave registra aquele PC, e ninguém toma a impressão digital de outro para a conta dele.
        const normalized = normalizeEmail(email)
        const auth = parseRelayAuth(request.headers.authorization, request.headers['x-kora-certificate'] as string | undefined)
        const checked = normalized && auth ? checkRelayAuth(auth, `/a/entrar/${normalized}`, this.now()) : 'invalid'
        if (checked === 'stale') return reply(response, 400, { erro: 'A data e a hora deste PC estão erradas. Ligue o ajuste automático nas configurações do Windows.' })
        if (!normalized || !auth || checked !== 'ok') return reply(response, 400, { erro: 'Pedido inválido.' })
        const result = await this.accounts.login(normalized, text('senha'), ip)
        if (!result.ok) {
          const messages = { invalid: 'E-mail ou senha incorretos.', locked: 'Muitas tentativas erradas. Espere alguns minutos e tente de novo.', blocked: 'Esta conta foi suspensa.' }
          return reply(response, result.reason === 'locked' ? 429 : 400, { erro: messages[result.reason] })
        }
        // Quem prova a chave é o dono da impressão digital: se alguém a registrou antes como celular (lendo o /health
        // na rede local, por exemplo), o registro vira PC desta conta.
        await this.sql.begin(async (tx) => {
          await tx`delete from kora_sync.phone_pcs where phone = ${auth.fingerprint}`
          await tx`
            insert into kora_sync.devices (fingerprint, account_id, kind, name) values (${auth.fingerprint}, ${result.accountId}, 'pc', ${text('nome').slice(0, 60) || null})
            on conflict (fingerprint) do update set account_id = excluded.account_id, kind = 'pc', name = coalesce(excluded.name, kora_sync.devices.name)`
        })
        this.cache.delete(auth.fingerprint)
        const client = String(request.headers['x-kora-client'] ?? '')
        this.seen(auth.fingerprint, { ip, client: CLIENT.test(client) ? client : '' })
        return reply(response, 200, { ok: true, admin: result.admin })
      }
    }
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
