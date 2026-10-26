import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { Sql } from './db.ts'
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
// Senha errada: 5 tentativas livres, depois a conta espera 15 min, dobrando a cada nova rodada de erros.
const FREE_FAILURES = 5
const LOCK_MS = 15 * 60_000

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
    const account = await this.pending(rawEmail, 'verify', code)
    if (!account) return { ok: false, reason: 'invalid' }
    await this.sql`update kora_sync.accounts set password_hash = ${await hashPassword(password)}, verified_at = now() where id = ${account}`
    return { ok: true, accountId: account }
  }

  async requestReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail)
    if (!email) return
    const [account] = await this.sql<{ id: string }[]>`select id from kora_sync.accounts where email = ${email} and verified_at is not null`
    if (account) await this.sendCode(account.id, email, 'reset')
  }

  async confirmReset(rawEmail: string, code: string, password: string): Promise<CodeResult> {
    if (passwordProblem(password)) return { ok: false, reason: 'weak-password' }
    const account = await this.pending(rawEmail, 'reset', code)
    if (!account) return { ok: false, reason: 'invalid' }
    await this.sql`update kora_sync.accounts set password_hash = ${await hashPassword(password)} where id = ${account}`
    this.failures.delete(account)
    return { ok: true, accountId: account }
  }

  async login(rawEmail: string, password: string): Promise<AuthResult> {
    const email = normalizeEmail(rawEmail)
    const [account] = email
      ? await this.sql<{ id: string; password_hash: string | null; blocked: boolean; admin: boolean }[]>`
          select id, password_hash, blocked_at is not null as blocked, admin
          from kora_sync.accounts where email = ${email}`
      : []
    const lock = account && this.failures.get(account.id)
    if (lock && lock.lockedUntil > this.now()) return { ok: false, reason: 'locked' }
    // Conta inexistente ou ainda sem verificação (sem senha): confere contra um hash falso, para o tempo de resposta
    // não denunciar quais e-mails têm conta.
    const valid = await verifyPassword(password, account?.password_hash ?? (await decoyHash())) && Boolean(account?.password_hash)
    if (!account || !valid) {
      if (account) this.fail(account.id)
      return { ok: false, reason: 'invalid' }
    }
    this.failures.delete(account.id)
    if (account.blocked) return { ok: false, reason: 'blocked' }
    await this.sql`update kora_sync.accounts set last_login_at = now() where id = ${account.id}`
    return { ok: true, accountId: account.id, admin: account.admin }
  }

  private fail(accountId: string): void {
    const entry = this.failures.get(accountId) ?? { count: 0, rounds: 0, lockedUntil: 0 }
    entry.count++
    if (entry.count >= FREE_FAILURES) {
      entry.lockedUntil = this.now() + LOCK_MS * 2 ** entry.rounds
      entry.rounds++
      entry.count = 0
    }
    this.failures.set(accountId, entry)
  }

  private codeHash(accountId: string, kind: EmailKind, code: string): string {
    return createHmac('sha256', this.options.codeSecret).update(`${accountId}:${kind}:${code}`).digest('base64')
  }

  private async sendCode(accountId: string, email: string, kind: EmailKind): Promise<void> {
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
    await this.mailer.send(email, renderEmail(kind, { code, minutes: CODE_MINUTES, logoUrl: this.options.logoUrl }))
  }

  // Confere o código e o consome. Errou demais ou venceu: o código morre e é preciso pedir outro.
  private async pending(rawEmail: string, kind: EmailKind, code: string): Promise<string | null> {
    const email = normalizeEmail(rawEmail)
    if (!email || !/^\d{6}$/.test(code)) return null
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ account_id: string; code_hash: string; expired: boolean; attempts: number }[]>`
        select c.account_id, c.code_hash, c.expires_at < ${new Date(this.now())} as expired, c.attempts
        from kora_sync.codes c join kora_sync.accounts a on a.id = c.account_id
        where a.email = ${email} and c.kind = ${kind}
        for update of c`
      if (!row) return null
      const expected = Buffer.from(row.code_hash)
      const actual = Buffer.from(this.codeHash(row.account_id, kind, code))
      const matches = expected.length === actual.length && timingSafeEqual(expected, actual)
      if (matches && !row.expired) {
        await tx`delete from kora_sync.codes where account_id = ${row.account_id} and kind = ${kind}`
        return row.account_id
      }
      if (row.expired || row.attempts + 1 >= CODE_ATTEMPTS) await tx`delete from kora_sync.codes where account_id = ${row.account_id} and kind = ${kind}`
      else await tx`update kora_sync.codes set attempts = attempts + 1 where account_id = ${row.account_id} and kind = ${kind}`
      return null
    })
  }
}
