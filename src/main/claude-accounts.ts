import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as pty from 'node-pty'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import type { ClaudeAccount, ClaudeAccountsView, ClaudeLogin, WeeklyUsage } from '../shared/claude-accounts'
import type { UsageWindow } from '../shared/usage-types'
import { terminalEnv } from './terminals'

// Único destino do token além do próprio Claude Code: o mesmo endpoint que ele usa para saber de quem é o login.
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const PROFILE_TIMEOUT_MS = 10_000
// Token a menos de um minuto de vencer pode cair entre a leitura e a consulta.
const ACCESS_MARGIN_MS = 60_000
const LOGIN_TIMEOUT_MS = 10 * 60_000

const OauthSchema = z.looseObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  refreshTokenExpiresAt: z.number().nullish(),
  subscriptionType: z.string().nullish()
})
type ClaudeOauth = z.infer<typeof OauthSchema>

const ProfileSchema = z.object({
  account: z.looseObject({ uuid: z.string().min(1), email: z.string().min(1) }),
  organization: z.looseObject({ uuid: z.string().min(1), name: z.string().nullish() })
})

const OauthAccountSchema = z.looseObject({ accountUuid: z.string().min(1), organizationUuid: z.string().min(1) })
type OauthAccount = z.infer<typeof OauthAccountSchema>

const StoredSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  organizationName: z.string().nullable(),
  subscriptionType: z.string().nullable(),
  refreshTokenExpiresAt: z.number().nullable(),
  weekly: z.object({ usedPercent: z.number(), resetsAt: z.number().nullable(), recordedAt: z.number() }).nullish(),
  // Cópia do oauthAccount do ~/.claude.json da conta: é de onde o /status tira o e-mail e a organização.
  oauthAccount: OauthAccountSchema.nullish(),
  secret: z.string().min(1)
})
type Stored = z.infer<typeof StoredSchema>

const VaultSchema = z.object({ version: z.literal(1), accounts: z.array(StoredSchema) })
type Vault = z.infer<typeof VaultSchema>

interface Identity {
  id: string
  email: string
  organizationName: string | null
  oauthAccount?: OauthAccount
}

export interface Secrets {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export interface ClaudeAccountsDeps {
  claudeRoot: string
  // ~/.claude.json: fora da pasta do Claude quando CLAUDE_CONFIG_DIR não está definido.
  globalConfigFile: string
  vaultFile: string
  // Pasta onde nasce a configuração temporária de cada login novo.
  scratchDir: string
  secrets: Secrets
  fetch?: typeof fetch
  now?: () => number
  lockRetries?: number
  onChange?: () => void
}

export class CredentialsFormatError extends Error {
  constructor() {
    super('Credenciais do Claude Code em formato desconhecido; a troca de conta foi bloqueada para não estragar o login')
  }
}

async function fetchProfile(accessToken: string, fetchImpl: typeof fetch): Promise<Identity> {
  const res = await fetchImpl(CLAUDE_PROFILE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`api.anthropic.com respondeu HTTP ${res.status} ao identificar a conta`)
  const parsed = ProfileSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('Perfil da conta do Claude em formato desconhecido')
  const { account, organization } = parsed.data
  return {
    id: `${account.uuid}:${organization.uuid}`,
    email: account.email,
    organizationName: organization.name ?? null,
    oauthAccount: oauthAccountFromProfile(account, organization)
  }
}

// Mesmos nomes que o Claude Code grava no oauthAccount depois do login; o que o perfil não traz ele completa sozinho.
function oauthAccountFromProfile(
  account: Record<string, unknown> & { uuid: string; email: string },
  organization: Record<string, unknown> & { uuid: string }
): OauthAccount {
  const fields: Record<string, unknown> = {
    accountUuid: account.uuid,
    emailAddress: account.email,
    organizationUuid: organization.uuid,
    displayName: account['display_name'],
    fullName: account['full_name'],
    accountCreatedAt: account['created_at'],
    organizationName: organization['name'],
    organizationType: organization['organization_type'],
    billingType: organization['billing_type'],
    hasExtraUsageEnabled: organization['has_extra_usage_enabled'],
    organizationRateLimitTier: organization['rate_limit_tier'],
    seatTier: organization['seat_tier'],
    subscriptionCreatedAt: organization['subscription_created_at']
  }
  return OauthAccountSchema.parse(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)))
}

const accountKey = (oauthAccount: OauthAccount): string => `${oauthAccount.accountUuid}:${oauthAccount.organizationUuid}`

async function readOauthAccount(configFile: string): Promise<OauthAccount | null> {
  try {
    const parsed = OauthAccountSchema.safeParse((await readJsonObject(configFile))?.['oauthAccount'])
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Grava o oauthAccount no ~/.claude.json com a trava que o Claude Code usa nesse arquivo (proper-lockfile em
 * <arquivo>.lock). Ele grava relendo o disco dentro da trava, então um Claude aberto não desfaz esta mudança.
 */
async function writeOauthAccount(configFile: string, oauthAccount: OauthAccount, retries: number): Promise<void> {
  let compromised = false
  const release = await lockfile.lock(configFile, {
    lockfilePath: `${configFile}.lock`,
    retries: { retries, minTimeout: 200, maxTimeout: 1_000 },
    onCompromised: () => {
      compromised = true
    }
  })
  try {
    const config = await readJsonObject(configFile)
    if (!config) return
    if (compromised) throw new Error('A trava do ~/.claude.json foi perdida')
    await writeJsonAtomic(configFile, { ...config, oauthAccount })
  } finally {
    await release().catch(() => {})
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CredentialsFormatError()
  return value as Record<string, unknown>
}

async function readCredentials(file: string): Promise<{ raw: Record<string, unknown>; oauth: ClaudeOauth | null }> {
  let raw: Record<string, unknown> | null
  try {
    raw = await readJsonObject(file)
  } catch (err) {
    if (err instanceof SyntaxError) throw new CredentialsFormatError()
    throw err
  }
  if (!raw || raw['claudeAiOauth'] === undefined) return { raw: raw ?? {}, oauth: null }
  const parsed = OauthSchema.safeParse(raw['claudeAiOauth'])
  if (!parsed.success) throw new CredentialsFormatError()
  return { raw, oauth: parsed.data }
}

// O Claude Code segura o arquivo aberto por instantes ao ler; o rename do Windows falha com EPERM nesse meio-tempo.
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.kora-${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await rm(tmp, { force: true })
        throw err
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
    }
  }
}

/**
 * Mesma trava que o Claude Code pega para renovar o login (proper-lockfile em <config>/.oauth_refresh.lock e a
 * antiga <config>.lock). Dentro dela ele relê o arquivo e só grava se o refreshToken no disco ainda for o que ele
 * usou; sem a trava, uma troca no meio de uma renovação faria o Claude adotar a conta nova e descartar a renovação
 * da antiga, que ficaria morta no cofre.
 */
async function withClaudeLock<T>(claudeRoot: string, retries: number, fn: () => Promise<T>): Promise<T> {
  let compromised = false
  const options = {
    realpath: false,
    stale: 60_000,
    update: 5_000,
    retries: { retries, minTimeout: 1_000, maxTimeout: 2_000 },
    onCompromised: () => {
      compromised = true
    }
  }
  const release = await lockfile.lock(claudeRoot, { ...options, lockfilePath: join(claudeRoot, '.oauth_refresh.lock') })
  let releaseLegacy: (() => Promise<void>) | null = null
  try {
    let legacyPath = `${claudeRoot}.lock`
    try {
      legacyPath = `${realpathSync(claudeRoot)}.lock`
    } catch {
      // Pasta sem caminho real resolvível: o Claude usa o caminho como veio.
    }
    releaseLegacy = await lockfile.lock(legacyPath, { ...options, lockfilePath: legacyPath })
    const result = await fn()
    if (compromised) throw new Error('A trava do login do Claude foi perdida durante a troca; confira a conta ativa')
    return result
  } finally {
    await releaseLegacy?.().catch(() => {})
    await release().catch(() => {})
  }
}

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g
// oxlint-disable-next-line no-control-regex
const AUTHORIZE_URL = /https:\/\/claude\.(?:com|ai)\/[^\s\u0007\u001b"'<>]*oauth\/authorize\?[^\s\u0007\u001b"'<>]+/

export class ClaudeAccounts {
  private readonly credentialsFile: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private login: ClaudeLogin = null
  private loginProcess: pty.IPty | null = null
  private lastSignature = ''

  constructor(private readonly deps: ClaudeAccountsDeps) {
    this.credentialsFile = join(deps.claudeRoot, '.credentials.json')
    this.fetchImpl = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  // O cofre e o arquivo do Claude só mudam um passo por vez: a sincronização periódica não pode cair no meio de uma troca.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private async loadVault(): Promise<Vault> {
    let raw: string
    try {
      raw = await readFile(this.deps.vaultFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] }
      throw err
    }
    let parsed: Vault | null = null
    try {
      parsed = VaultSchema.parse(JSON.parse(raw))
    } catch {
      // Cofre ilegível não pode travar a troca para sempre nem ser sobrescrito: fica guardado ao lado e as contas
      // voltam com um login novo.
      await rename(this.deps.vaultFile, `${this.deps.vaultFile}.corrupt-${this.now()}`)
    }
    return parsed ?? { version: 1, accounts: [] }
  }

  private saveVault(vault: Vault): Promise<void> {
    return writeJsonAtomic(this.deps.vaultFile, vault)
  }

  private secretOf(stored: Stored): ClaudeOauth {
    return OauthSchema.parse(JSON.parse(this.deps.secrets.decrypt(stored.secret)))
  }

  private upsert(vault: Vault, identity: Identity, oauth: ClaudeOauth, oauthAccount: OauthAccount | null = null): boolean {
    const index = vault.accounts.findIndex((a) => a.id === identity.id)
    const previous = index >= 0 ? vault.accounts[index] : null
    const nextOauthAccount = oauthAccount ?? previous?.oauthAccount ?? null
    const sameOauthAccount = JSON.stringify(nextOauthAccount) === JSON.stringify(previous?.oauthAccount ?? null)
    if (previous && sameOauthAccount) {
      let saved: ClaudeOauth | null = null
      try {
        saved = this.secretOf(previous)
      } catch {
        // Segredo que não abre mais (outro usuário do Windows, cofre copiado de outra máquina): é substituído.
      }
      if (saved?.refreshToken === oauth.refreshToken && saved.accessToken === oauth.accessToken) return false
    }
    const stored: Stored = {
      id: identity.id,
      email: identity.email,
      organizationName: identity.organizationName,
      subscriptionType: oauth.subscriptionType ?? null,
      refreshTokenExpiresAt: oauth.refreshTokenExpiresAt ?? null,
      weekly: previous?.weekly ?? null,
      oauthAccount: nextOauthAccount,
      secret: this.deps.secrets.encrypt(JSON.stringify(oauth))
    }
    if (index >= 0) vault.accounts[index] = stored
    else vault.accounts.push(stored)
    return true
  }

  // Pelo refreshToken guardado não há consulta à rede; o perfil só é pedido para login que o Kora ainda não viu.
  private async identify(oauth: ClaudeOauth, vault: Vault): Promise<Identity | null> {
    for (const stored of vault.accounts) {
      let saved: ClaudeOauth
      try {
        saved = this.secretOf(stored)
      } catch {
        continue
      }
      if (saved.refreshToken === oauth.refreshToken) {
        return { id: stored.id, email: stored.email, organizationName: stored.organizationName }
      }
    }
    if (oauth.expiresAt <= this.now() + ACCESS_MARGIN_MS) return null
    return fetchProfile(oauth.accessToken, this.fetchImpl)
  }

  private view(vault: Vault, activeId: string | null, activeUnknown: boolean): ClaudeAccountsView {
    const accounts: ClaudeAccount[] = vault.accounts.map((a) => ({
      id: a.id,
      email: a.email,
      organizationName: a.organizationName,
      subscriptionType: a.subscriptionType,
      refreshTokenExpiresAt: a.refreshTokenExpiresAt,
      weekly: a.weekly ?? null,
      active: a.id === activeId
    }))
    return { accounts, activeUnknown, login: this.login }
  }

  // Guarda no cofre o login atual do Claude Code (o primeiro vira conta sem precisar adicionar) e a versão mais
  // nova dos tokens dele, que o Claude troca a cada renovação.
  private async syncNow(): Promise<ClaudeAccountsView> {
    const vault = await this.loadVault()
    let oauth: ClaudeOauth | null
    try {
      oauth = (await readCredentials(this.credentialsFile)).oauth
    } catch {
      return this.view(vault, null, true)
    }
    if (!oauth) return this.view(vault, null, false)
    let identity: Identity | null = null
    try {
      identity = await this.identify(oauth, vault)
    } catch {
      identity = null
    }
    if (identity) {
      const global = await readOauthAccount(this.deps.globalConfigFile)
      const own = global && accountKey(global) === identity.id ? global : null
      if (this.upsert(vault, identity, oauth, own ?? identity.oauthAccount ?? null)) await this.saveVault(vault)
      // O token é de uma conta e o ~/.claude.json fala de outra: o /status mostraria a conta errada.
      if (global && !own) await this.writeOauthAccountOf(vault, identity.id, oauth)
    }
    return this.view(vault, identity?.id ?? null, identity === null)
  }

  private async writeOauthAccountOf(vault: Vault, id: string, oauth: ClaudeOauth): Promise<void> {
    const stored = vault.accounts.find((a) => a.id === id)
    let oauthAccount = stored?.oauthAccount ?? null
    if (!oauthAccount && oauth.expiresAt > this.now() + ACCESS_MARGIN_MS) {
      oauthAccount = (await fetchProfile(oauth.accessToken, this.fetchImpl).catch(() => null))?.oauthAccount ?? null
    }
    if (!oauthAccount) {
      const [accountUuid, organizationUuid] = id.split(':')
      oauthAccount = OauthAccountSchema.parse({
        accountUuid,
        organizationUuid,
        emailAddress: stored?.email,
        organizationName: stored?.organizationName ?? undefined
      })
    }
    try {
      await writeOauthAccount(this.deps.globalConfigFile, oauthAccount, this.deps.lockRetries ?? 10)
    } catch {
      // O login já trocou; só o rótulo do /status fica atrasado até a próxima sincronização.
    }
  }

  list(): Promise<ClaudeAccountsView> {
    return this.serial(() => this.syncNow())
  }

  /** Para a verificação periódica: true quando algo visível mudou desde a última vez. */
  async sync(): Promise<boolean> {
    const view = await this.list()
    const signature = JSON.stringify(view)
    if (signature === this.lastSignature) return false
    this.lastSignature = signature
    return true
  }

  /**
   * Troca o login do Claude Code de todo o computador. Os processos do Claude já abertos percebem o arquivo novo
   * e passam a usar a conta escolhida sem reiniciar.
   */
  switchTo(id: string): Promise<ClaudeAccountsView> {
    return this.serial(async () => {
      const vault = await this.loadVault()
      const target = vault.accounts.find((a) => a.id === id)
      if (!target) throw new Error('Conta não encontrada no Kora')
      const targetOauth = this.secretOf(target)
      if (targetOauth.refreshTokenExpiresAt != null && targetOauth.refreshTokenExpiresAt <= this.now()) {
        throw new Error(`O login de ${target.email} venceu; entre de novo nessa conta`)
      }
      await withClaudeLock(this.deps.claudeRoot, this.deps.lockRetries ?? 10, async () => {
        const { raw, oauth } = await readCredentials(this.credentialsFile)
        if (oauth) {
          const current = await this.identify(oauth, vault).catch(() => null)
          if (!current) {
            throw new Error('Não reconheci a conta logada agora no Claude Code. Abra o Claude uma vez para renovar o login e tente de novo')
          }
          if (current.id === id) return
          const global = await readOauthAccount(this.deps.globalConfigFile)
          const own = global && accountKey(global) === current.id ? global : null
          // A conta que sai vai para o cofre antes de o arquivo mudar: se a gravação falhar depois, nada se perde.
          if (this.upsert(vault, current, oauth, own)) await this.saveVault(vault)
        }
        await writeJsonAtomic(this.credentialsFile, { ...raw, claudeAiOauth: targetOauth })
      })
      await this.writeOauthAccountOf(vault, id, targetOauth)
      return this.view(vault, id, false)
    })
  }

  /**
   * Guarda o limite semanal geral na conta dona do token que fez a consulta. Pelo token, e não pela conta ativa:
   * uma consulta que sai antes de uma troca e volta depois dela é da conta anterior.
   */
  recordUsage(accessToken: string, windows: UsageWindow[]): Promise<void> {
    return this.serial(async () => {
      const weekly = windows.find((w) => w.label === 'Semanal' && w.windowMinutes === 10080)
      if (!weekly) return
      const vault = await this.loadVault()
      const stored = vault.accounts.find((a) => {
        try {
          return this.secretOf(a).accessToken === accessToken
        } catch {
          return false
        }
      })
      if (!stored) return
      const next: WeeklyUsage = { usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt, recordedAt: this.now() }
      stored.weekly = next
      await this.saveVault(vault)
      this.deps.onChange?.()
    })
  }

  remove(id: string): Promise<ClaudeAccountsView> {
    return this.serial(async () => {
      const view = await this.syncNow()
      if (view.accounts.some((a) => a.id === id && a.active)) {
        throw new Error('A conta em uso não pode ser removida; troque para outra antes')
      }
      const vault = await this.loadVault()
      vault.accounts = vault.accounts.filter((a) => a.id !== id)
      await this.saveVault(vault)
      return this.view(vault, view.accounts.find((a) => a.active)?.id ?? null, view.activeUnknown)
    })
  }

  /** Lê o login que o `claude auth login` gravou numa pasta de configuração separada e o guarda no cofre. */
  adoptLogin(configDir: string): Promise<Identity> {
    return this.serial(async () => {
      const { oauth } = await readCredentials(join(configDir, '.credentials.json'))
      if (!oauth) throw new Error('O login terminou sem credenciais do Claude')
      const identity = await fetchProfile(oauth.accessToken, this.fetchImpl)
      const written = await readOauthAccount(join(configDir, '.claude.json'))
      const own = written && accountKey(written) === identity.id ? written : null
      const vault = await this.loadVault()
      if (this.upsert(vault, identity, oauth, own ?? identity.oauthAccount ?? null)) await this.saveVault(vault)
      return identity
    })
  }

  /**
   * Roda `claude auth login` num terminal oculto apontado para uma pasta própria: o login da conta nova não toca
   * no login atual do computador. O navegador abre sozinho; se o Claude pedir, o código colado vai por loginCode.
   */
  async startLogin(email?: string): Promise<void> {
    if (this.login?.state === 'running') throw new Error('Já há um login em andamento')
    if (email !== undefined && !/^[^\s'"`;$]+@[^\s'"`;$]+$/.test(email)) throw new Error('E-mail inválido')
    const configDir = await mkdtemp(join(this.deps.scratchDir, 'claude-login-'))
    const command = email ? `claude auth login --email '${email}'` : 'claude auth login'
    const proc = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
      name: 'xterm-256color',
      // Largo o bastante para a URL de autorização não quebrar em linhas.
      cols: 4000,
      rows: 30,
      cwd: this.deps.scratchDir,
      env: { ...terminalEnv(process.env), CLAUDE_CONFIG_DIR: configDir }
    })
    this.loginProcess = proc
    this.login = { state: 'running', url: null }
    this.deps.onChange?.()
    let output = ''
    let cancelled = false
    const timer = setTimeout(() => {
      cancelled = true
      proc.kill()
    }, LOGIN_TIMEOUT_MS)
    proc.onData((data) => {
      output = (output + data).slice(-64_000)
      if (this.login?.state === 'running' && this.login.url === null) {
        const url = output.match(AUTHORIZE_URL)?.[0]
        if (url) {
          this.login = { state: 'running', url }
          this.deps.onChange?.()
        }
      }
    })
    proc.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (this.loginProcess === proc) this.loginProcess = null
      cancelled ||= this.login === null
      const finish = async (): Promise<void> => {
        try {
          if (cancelled) {
            this.login = null
            return
          }
          if (exitCode !== 0) throw new Error(lastLine(output) ?? `claude auth login terminou com código ${exitCode}`)
          await this.adoptLogin(configDir)
          this.login = null
        } catch (err) {
          this.login = { state: 'failed', message: err instanceof Error ? err.message : 'Falha no login' }
        } finally {
          await rm(configDir, { recursive: true, force: true }).catch(() => {})
          this.deps.onChange?.()
        }
      }
      void finish()
    })
  }

  loginCode(code: string): void {
    const clean = code.trim()
    if (clean && this.loginProcess) this.loginProcess.write(`${clean}\r`)
  }

  cancelLogin(): void {
    const proc = this.loginProcess
    this.login = null
    this.deps.onChange?.()
    proc?.kill()
  }

  dismissLogin(): void {
    if (this.login?.state === 'failed') {
      this.login = null
      this.deps.onChange?.()
    }
  }
}

function lastLine(output: string): string | null {
  const lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes('oauth/authorize'))
  return lines.at(-1)?.slice(0, 300) ?? null
}
