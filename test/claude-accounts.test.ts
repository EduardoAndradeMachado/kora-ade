import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeAccounts, CLAUDE_PROFILE_URL, CredentialsFormatError } from '../src/main/claude-accounts'

const NOW = Date.parse('2026-10-11T03:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

// Formato real de GET /api/oauth/profile (capturado em out/2026), reduzido aos campos que o Kora lê e alguns vizinhos.
function profile(who: 'a' | 'b' | 'c'): unknown {
  return {
    account: {
      uuid: `acc-${who}`,
      full_name: `Pessoa ${who}`,
      display_name: who,
      email: `${who}@exemplo.com`,
      has_claude_max: true,
      has_claude_pro: false,
      created_at: '2025-01-01T00:00:00Z'
    },
    organization: {
      uuid: `org-${who}`,
      name: `Org ${who}`,
      organization_type: 'claude_max',
      billing_type: 'stripe_subscription',
      rate_limit_tier: 'default_claude_max_20x',
      seat_tier: null,
      has_extra_usage_enabled: false,
      subscription_status: 'active'
    },
    application: { uuid: 'app', name: 'Claude Code', slug: 'claude-code' },
    enabled_plugins: {}
  }
}

// Mesmo formato do claudeAiOauth do .credentials.json do Claude Code 2.1.296.
function oauth(who: 'a' | 'b' | 'c', generation: number, opts: { accessExpiresAt?: number; refreshExpiresAt?: number } = {}) {
  return {
    accessToken: `at-${who}-${generation}`,
    refreshToken: `rt-${who}-${generation}`,
    expiresAt: opts.accessExpiresAt ?? NOW + 8 * HOUR,
    refreshTokenExpiresAt: opts.refreshExpiresAt ?? NOW + 20 * DAY,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x'
  }
}

// O oauthAccount que o próprio Claude Code grava traz campos que o perfil não tem (organizationRole).
function claudeOauthAccount(who: 'a' | 'b' | 'c'): Record<string, unknown> {
  return {
    accountUuid: `acc-${who}`,
    emailAddress: `${who}@exemplo.com`,
    organizationUuid: `org-${who}`,
    organizationName: `Org ${who}`,
    billingType: 'stripe_subscription',
    organizationRole: 'admin',
    workspaceRole: null
  }
}

let root: string
let claudeRoot: string
let calls: { url: string; init?: RequestInit }[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kora-accounts-'))
  claudeRoot = join(root, '.claude')
  mkdirSync(claudeRoot)
  calls = []
  writeGlobal({ numStartups: 42, projects: { 'C:/proj': { allowedTools: [] } }, oauthAccount: claudeOauthAccount('a') })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const credentialsFile = (): string => join(claudeRoot, '.credentials.json')
const writeCredentials = (value: unknown): void => writeFileSync(credentialsFile(), JSON.stringify(value), 'utf8')
const readCredentials = (): Record<string, unknown> => JSON.parse(readFileSync(credentialsFile(), 'utf8'))
const globalFile = (): string => join(root, '.claude.json')
function writeGlobal(value: unknown): void {
  writeFileSync(globalFile(), JSON.stringify(value), 'utf8')
}
const readGlobal = (): Record<string, unknown> => JSON.parse(readFileSync(globalFile(), 'utf8'))

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  calls.push({ url: String(input), init })
  const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
  const who = /^at-([abc])-/.exec(token)?.[1] as 'a' | 'b' | 'c' | undefined
  if (!who) return new Response('{}', { status: 401 })
  return new Response(JSON.stringify(profile(who)), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

function accounts(): ClaudeAccounts {
  return new ClaudeAccounts({
    claudeRoot,
    globalConfigFile: globalFile(),
    vaultFile: join(root, 'claude-accounts.json'),
    scratchDir: root,
    secrets: {
      encrypt: (plain) => `cifrado:${Buffer.from(plain).toString('base64')}`,
      decrypt: (cipher) => {
        if (!cipher.startsWith('cifrado:')) throw new Error('segredo inválido')
        return Buffer.from(cipher.slice('cifrado:'.length), 'base64').toString()
      }
    },
    fetch: fakeFetch,
    now: () => NOW,
    lockRetries: 0
  })
}

// Conta que entrou pelo "Adicionar conta": o claude auth login gravou numa pasta de configuração só dela.
async function addAccount(
  kora: ClaudeAccounts,
  who: 'a' | 'b' | 'c',
  generation = 1,
  opts: { accessExpiresAt?: number; refreshExpiresAt?: number; withConfig?: boolean } = {}
): Promise<string> {
  const dir = mkdtempSync(join(root, 'login-'))
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth(who, generation, opts) }), 'utf8')
  if (opts.withConfig !== false) {
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: claudeOauthAccount(who) }), 'utf8')
  }
  return (await kora.adoptLogin(dir)).id
}

describe('contas do Claude', () => {
  it('o login atual entra no cofre sozinho, cifrado, e o perfil só vai para api.anthropic.com sem redirecionamento', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const view = await accounts().list()
    expect(view.accounts).toEqual([
      expect.objectContaining({ id: 'acc-a:org-a', email: 'a@exemplo.com', organizationName: 'Org a', active: true })
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(CLAUDE_PROFILE_URL)
    expect(new URL(calls[0]!.url).host).toBe('api.anthropic.com')
    expect(calls[0]!.init?.redirect).toBe('error')
    const vault = readFileSync(join(root, 'claude-accounts.json'), 'utf8')
    expect(vault).not.toContain('rt-a-1')
    expect(vault).not.toContain('at-a-1')
  })

  it('trocar grava a conta escolhida e mantém o resto do arquivo (logins de MCP)', async () => {
    const mcp = { notion: { accessToken: 'mcp-token', expiresAt: NOW + DAY } }
    writeCredentials({ claudeAiOauth: oauth('a', 1), mcpOAuth: mcp, outraChave: 7 })
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    const view = await kora.switchTo(b)
    expect(readCredentials()).toEqual({ claudeAiOauth: oauth('b', 1), mcpOAuth: mcp, outraChave: 7 })
    expect(view.accounts.find((x) => x.active)?.email).toBe('b@exemplo.com')
  })

  it('a conta que sai vai para o cofre com os tokens que o Claude renovou, e volta com eles', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    await kora.list()
    // O Claude renovou o login da conta A depois que o Kora a guardou: o rt-a-1 já não vale mais.
    writeCredentials({ claudeAiOauth: oauth('a', 2) })
    const b = await addAccount(kora, 'b')
    await kora.switchTo(b)
    await kora.switchTo('acc-a:org-a')
    expect(readCredentials()['claudeAiOauth']).toEqual(oauth('a', 2))
  })

  it('reconhece pelo cofre o login com token de acesso vencido, sem consultar a rede', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    await kora.list()
    writeCredentials({ claudeAiOauth: oauth('a', 1, { accessExpiresAt: NOW - HOUR }) })
    const b = await addAccount(kora, 'b')
    const before = calls.length
    await kora.switchTo(b)
    expect(calls).toHaveLength(before)
    expect(readCredentials()['claudeAiOauth']).toEqual(oauth('b', 1))
  })

  it('não troca, nem toca no arquivo, quando não sabe de quem é o login atual', async () => {
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    writeCredentials({ claudeAiOauth: oauth('c', 1, { accessExpiresAt: NOW - HOUR }) })
    const before = readFileSync(credentialsFile(), 'utf8')
    await expect(kora.switchTo(b)).rejects.toThrow(/Não reconheci a conta/)
    expect(readFileSync(credentialsFile(), 'utf8')).toBe(before)
    expect(calls.some((c) => new Headers(c.init?.headers).get('authorization') === 'Bearer at-c-1')).toBe(false)
  })

  it('formato de credenciais desconhecido bloqueia a troca sem tocar no arquivo', async () => {
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    writeCredentials({ claudeAiOauth: { accessToken: 'at-a-1', formatoNovo: true }, mcpOAuth: {} })
    const before = readFileSync(credentialsFile(), 'utf8')
    await expect(kora.switchTo(b)).rejects.toBeInstanceOf(CredentialsFormatError)
    expect(readFileSync(credentialsFile(), 'utf8')).toBe(before)
  })

  it('não grava enquanto o Claude segura a trava de renovação, nem a nova nem a antiga', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    const before = readFileSync(credentialsFile(), 'utf8')
    for (const lockfilePath of [join(claudeRoot, '.oauth_refresh.lock'), `${realpathSync(claudeRoot)}.lock`]) {
      // O Claude é outro processo; aqui a trava sai do mesmo processo, então vai por um caminho próprio para o
      // registro interno do proper-lockfile não confundir com a do Kora. No disco é o mesmo diretório de trava.
      const release = await lockfile.lock(lockfilePath, { lockfilePath, realpath: false })
      await expect(kora.switchTo(b)).rejects.toThrow()
      expect(readFileSync(credentialsFile(), 'utf8')).toBe(before)
      await release()
    }
    await kora.switchTo(b)
    expect(readCredentials()['claudeAiOauth']).toEqual(oauth('b', 1))
  })

  it('conta com login vencido não é ativada', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    const b = await addAccount(kora, 'b', 1, { refreshExpiresAt: NOW - 1 })
    await expect(kora.switchTo(b)).rejects.toThrow(/b@exemplo\.com venceu/)
    expect(readCredentials()['claudeAiOauth']).toEqual(oauth('a', 1))
  })

  it('o /status acompanha: trocar grava o oauthAccount da conta no ~/.claude.json e mantém o resto dele', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    await kora.switchTo(b)
    expect(readGlobal()).toEqual({
      numStartups: 42,
      projects: { 'C:/proj': { allowedTools: [] } },
      oauthAccount: claudeOauthAccount('b')
    })
    // A volta usa o oauthAccount que o Claude tinha gravado para a conta A, com os campos que o perfil não traz.
    await kora.switchTo('acc-a:org-a')
    expect(readGlobal()['oauthAccount']).toEqual(claudeOauthAccount('a'))
  })

  it('conta que entrou sem oauthAccount ganha um montado pelo perfil', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    const b = await addAccount(kora, 'b', 1, { withConfig: false })
    await kora.switchTo(b)
    expect(readGlobal()['oauthAccount']).toMatchObject({
      accountUuid: 'acc-b',
      organizationUuid: 'org-b',
      emailAddress: 'b@exemplo.com',
      billingType: 'stripe_subscription'
    })
  })

  it('sincronizar corrige o ~/.claude.json quando o token é de uma conta e ele fala de outra', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    await addAccount(kora, 'b')
    writeCredentials({ claudeAiOauth: oauth('b', 1) })
    const view = await kora.list()
    expect(view.accounts.find((x) => x.active)?.email).toBe('b@exemplo.com')
    expect(readGlobal()['oauthAccount']).toEqual(claudeOauthAccount('b'))
    expect(readGlobal()['numStartups']).toBe(42)
  })

  it('não grava o ~/.claude.json enquanto o Claude segura a trava dele; a sincronização seguinte corrige', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    const lockfilePath = `${globalFile()}.lock`
    const release = await lockfile.lock(lockfilePath, { lockfilePath, realpath: false })
    await kora.switchTo(b)
    expect(readCredentials()['claudeAiOauth']).toEqual(oauth('b', 1))
    expect(readGlobal()['oauthAccount']).toEqual(claudeOauthAccount('a'))
    await release()
    await kora.list()
    expect(readGlobal()['oauthAccount']).toEqual(claudeOauthAccount('b'))
  })

  it('o uso semanal fica na conta dona do token que consultou, não na que está ativa', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    await kora.switchTo(b)
    const weekly = { label: 'Semanal', usedPercent: 64, resetsAt: NOW + DAY, windowMinutes: 10080 }
    // Consulta que saiu com o token da conta A antes da troca e só voltou depois.
    await kora.recordUsage('at-a-1', [{ label: '5 h', usedPercent: 3, resetsAt: NOW + HOUR, windowMinutes: 300 }, weekly])
    await kora.recordUsage('token-de-ninguém', [{ ...weekly, usedPercent: 99 }])
    const view = await kora.list()
    expect(view.accounts.find((x) => x.email === 'a@exemplo.com')?.weekly).toEqual({ usedPercent: 64, resetsAt: NOW + DAY, recordedAt: NOW })
    expect(view.accounts.find((x) => x.email === 'b@exemplo.com')?.weekly).toBeNull()
  })

  it('a conta em uso não pode ser removida; as outras saem do cofre', async () => {
    writeCredentials({ claudeAiOauth: oauth('a', 1) })
    const kora = accounts()
    const b = await addAccount(kora, 'b')
    await expect(kora.remove('acc-a:org-a')).rejects.toThrow(/em uso/)
    const view = await kora.remove(b)
    expect(view.accounts.map((x) => x.email)).toEqual(['a@exemplo.com'])
  })
})
