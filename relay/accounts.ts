import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { Sql, TransactionSql } from './db.ts'
import { renderEmail, type Email, type EmailKind } from './emails.ts'
import { PASSWORD_MAX, PASSWORD_MIN, decoyHash, hashPassword, verifyPassword } from './passwords.ts'

export interface Mailer {
  send(to: string, email: Email): Promise<void>
}

export interface AccountsOptions {
  // Segredo do HMAC dos códigos: com o banco vazado e sem ele, ninguém testa os 10^6 códigos offline.
  codeSecret: string
  logoUrl: string
  now?: () => number
}

export type AuthResult =
  | { ok: true; accountId: string; admin: boolean }
  | { ok: false; reason: 'invalid' | 'blocked' | 'locked' }

export type CodeResult = { ok: true; accountId: string } | { ok: false; reason: 'invalid' | 'weak-password' }

const CODE_MINUTES = 15
const CODE_ATTEMPTS = 5
// Pedir outro código antes disso não manda e-mail novo: ninguém usa o relay para encher a caixa de alguém.
const RESEND_MS = 60_000
// Senha errada: 5 tentativas livres, depois aquele e-mail espera 15 min naquele IP, dobrando a cada nova rodada.
// Por e-mail e IP: quem erra de propósito não trava o login da dona da conta em outra rede.
const FREE_FAILURES = 5
const LOCK_MS = 15 * 60_000
// Teto por conta, somando todos os códigos: pedir código novo zera as 5 tentativas daquele código, e sem este teto
// dava para ir adivinhando aos poucos (5 palpites por minuto). 10 erros por dia deixam a chance em 1 em 100 mil.
const CODE_MISSES_PER_DAY = 10
const CODES_PER_HOUR = 5

export const normalizeEmail = (email: string): string | null => {
  const value = email.trim().toLowerCase()
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}

export const passwordProblem = (password: string): string | null =>
  password.length < PASSWORD_MIN ? `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`
    : password.length > PASSWORD_MAX ? `A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`
    : null

export class Accounts {
  private readonly failures = new Map<string, { count: number; rounds: number; lockedUntil: number }>()
  private readonly codeMisses = new Map<string, { count: number; since: number }>()
  private readonly codesSent = new Map<string, { count: number; since: number }>()
  private readonly now: () => number
  private readonly sql: Sql
  private readonly mailer: Mailer
  private readonly options: AccountsOptions

  // Sem "private readonly" nos parâmetros: o Node do contêiner roda o TypeScript só tirando os tipos, e essa sintaxe
  // gera código.
  constructor(sql: Sql, mailer: Mailer, options: AccountsOptions) {
    this.sql = sql
    this.mailer = mailer
    this.options = options
    this.now = options.now ?? Date.now
  }

  // Cria a conta pendente (ou reaproveita a que ainda não foi verificada) e manda o código. E-mail já verificado não
  // recebe nada e a resposta é a mesma: o cadastro não revela quem tem conta.
  async signup(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail)
    if (!email) return
    const [account] = await this.sql<{ id: string; verified: boolean }[]>`
      insert into kora_sync.accounts (email) values (${email})
      on conflict (email) do update set email = excluded.email
      returning id, verified_at is not null as verified`
    if (!account || account.verified) return
    await this.sendCode(account.id, email, 'verify')
  }

  async verifySignup(rawEmail: string, code: string, password: string): Promise<CodeResult> {
    if (passwordProblem(password)) return { ok: false, reason: 'weak-password' }
    // O hash (caro) só depois de o código bater: código errado não custa nada ao relay.
    const account = await this.pending(rawEmail, 'verify', code, async (tx, id) => tx`update kora_sync.accounts set password_hash = ${await hashPassword(password)}, verified_at = now() where id = ${id}`)
    return account ? { ok: true, accountId: account } : { ok: false, reason: 'invalid' }
  }

  async requestReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail)
    if (!email) return
    const [account] = await this.sql<{ id: string }[]>`select id from kora_sync.accounts where email = ${email} and verified_at is not null`
    if (account) await this.sendCode(account.id, email, 'reset')
  }

  async confirmReset(rawEmail: string, code: string, password: string): Promise<CodeResult> {
    if (passwordProblem(password)) return { ok: false, reason: 'weak-password' }
    const account = await this.pending(rawEmail, 'reset', code, async (tx, id) => tx`update kora_sync.accounts set password_hash = ${await hashPassword(password)} where id = ${id}`)
    return account ? { ok: true, accountId: account } : { ok: false, reason: 'invalid' }
  }

  // A trava vale igual para e-mail com e sem conta: errar 5 vezes não revela quem tem conta.
  async login(rawEmail: string, password: string, ip = ''): Promise<AuthResult> {
    const email = normalizeEmail(rawEmail)
    const key = `${email ?? rawEmail}|${ip}`
    const lock = this.failures.get(key)
    if (lock && lock.lockedUntil > this.now()) return { ok: false, reason: 'locked' }
    const [account] = email
      ? await this.sql<{ id: string; password_hash: string | null; blocked: boolean; admin: boolean }[]>`
          select id, password_hash, blocked_at is not null as blocked, admin
          from kora_sync.accounts where email = ${email}`
      : []
    // Conta inexistente ou ainda sem verificação (sem senha): confere contra um hash falso, para o tempo de resposta
    // não denunciar quais e-mails têm conta.
    const valid = await verifyPassword(password, account?.password_hash ?? (await decoyHash())) && Boolean(account?.password_hash)
    if (!account || !valid) {
      this.fail(key)
      return { ok: false, reason: 'invalid' }
    }
    this.failures.delete(key)
    if (account.blocked) return { ok: false, reason: 'blocked' }
    await this.sql`update kora_sync.accounts set last_login_at = now() where id = ${account.id}`
    return { ok: true, accountId: account.id, admin: account.admin }
  }

  private fail(key: string): void {
    const entry = this.failures.get(key) ?? { count: 0, rounds: 0, lockedUntil: 0 }
    entry.count++
    if (entry.count >= FREE_FAILURES) {
      entry.lockedUntil = this.now() + LOCK_MS * 2 ** entry.rounds
      entry.rounds++
      entry.count = 0
    }
    this.failures.set(key, entry)
  }

  // Contadores numa janela que começa no primeiro evento: count soma um, exhausted diz se já chegou ao limite.
  private count(map: Map<string, { count: number; since: number }>, key: string, windowMs: number): void {
    const now = this.now()
    const current = map.get(key)
    const entry = current && now - current.since < windowMs ? current : { count: 0, since: now }
    entry.count++
    map.set(key, entry)
  }

  private exhausted(map: Map<string, { count: number; since: number }>, key: string, limit: number, windowMs: number): boolean {
    const entry = map.get(key)
    return entry !== undefined && this.now() - entry.since < windowMs && entry.count >= limit
  }

  // Os contadores só crescem com IPs e contas novos: o que já venceu sai de tempos em tempos.
  sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.failures) if (entry.lockedUntil <= now && entry.count === 0) this.failures.delete(key)
    for (const map of [this.codeMisses, this.codesSent]) for (const [key, entry] of map) if (now - entry.since > 24 * 60 * 60_000) map.delete(key)
  }

  private codeHash(accountId: string, kind: EmailKind, code: string): string {
    return createHmac('sha256', this.options.codeSecret).update(`${accountId}:${kind}:${code}`).digest('base64')
  }

  private async sendCode(accountId: string, email: string, kind: EmailKind): Promise<void> {
    if (this.exhausted(this.codesSent, accountId, CODES_PER_HOUR, 60 * 60_000)) return
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expires = new Date(this.now() + CODE_MINUTES * 60_000)
    const recent = new Date(this.now() - RESEND_MS)
    // Um código vivo por conta e tipo; o novo substitui o anterior, menos quando o anterior acabou de sair.
    const [written] = await this.sql<{ account_id: string }[]>`
      insert into kora_sync.codes (account_id, kind, code_hash, expires_at, created_at)
      values (${accountId}, ${kind}, ${this.codeHash(accountId, kind, code)}, ${expires}, ${new Date(this.now())})
      on conflict (account_id, kind) do update
        set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at
        where kora_sync.codes.created_at < ${recent}
      returning account_id`
    if (!written) return
    this.count(this.codesSent, accountId, 60 * 60_000)
    try {
      await this.mailer.send(email, renderEmail(kind, { code, minutes: CODE_MINUTES, logoUrl: this.options.logoUrl }))
    } catch (error) {
      // E-mail que não saiu não pode deixar um código "recente" no banco: o pedido seguinte diria que mandou de novo
      // sem mandar nada.
      await this.sql`delete from kora_sync.codes where account_id = ${accountId} and kind = ${kind}`.catch(() => {})
      throw error
    }
  }

  // Confere o código e, na mesma transação, o consome e grava o que ele autoriza (apply): se a gravação falhar, o
  // código continua valendo. Errou demais ou venceu: o código morre e é preciso pedir outro.
  private async pending(rawEmail: string, kind: EmailKind, code: string, apply: (tx: TransactionSql, accountId: string) => Promise<unknown>): Promise<string | null> {
    const email = normalizeEmail(rawEmail)
    if (!email || !/^\d{6}$/.test(code)) return null
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ account_id: string; code_hash: string; expired: boolean; attempts: number }[]>`
        select c.account_id, c.code_hash, c.expires_at < ${new Date(this.now())} as expired, c.attempts
        from kora_sync.codes c join kora_sync.accounts a on a.id = c.account_id
        where a.email = ${email} and c.kind = ${kind}
        for update of c`
      if (!row) return null
      if (this.exhausted(this.codeMisses, row.account_id, CODE_MISSES_PER_DAY, 24 * 60 * 60_000)) {
        await tx`delete from kora_sync.codes where account_id = ${row.account_id} and kind = ${kind}`
        return null
      }
      const expected = Buffer.from(row.code_hash)
      const actual = Buffer.from(this.codeHash(row.account_id, kind, code))
      const matches = expected.length === actual.length && timingSafeEqual(expected, actual)
      if (matches && !row.expired) {
        await tx`delete from kora_sync.codes where account_id = ${row.account_id} and kind = ${kind}`
        await apply(tx, row.account_id)
        return row.account_id
      }
      if (!row.expired) this.count(this.codeMisses, row.account_id, 24 * 60 * 60_000)
      if (row.expired || row.attempts + 1 >= CODE_ATTEMPTS) await tx`delete from kora_sync.codes where account_id = ${row.account_id} and kind = ${kind}`
      else await tx`update kora_sync.codes set attempts = attempts + 1 where account_id = ${row.account_id} and kind = ${kind}`
      return null
    })
  }
}
