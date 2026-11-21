import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_USAGE_URL,
  createUsageReader,
  parseAntigravityUsage,
  readAntigravityUsage,
  UsageFormatError,
  type AntigravitySource
} from '../src/main/usage'

// Resposta real do retrieveUserQuotaSummary com o User-Agent do agy 1.5.9 (conta Pro, 2026-11-16).
const realSummary: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/antigravity-quota-summary.json', import.meta.url), 'utf8')
)

const NOW = Date.parse('2026-11-16T02:15:00Z')
const MIN = 60_000
const HOUR = 60 * MIN

const FAKE_TOKEN = 'ya29.FAKE-antigravity-access'
const FAKE_REFRESH = '1//FAKE-antigravity-refresh'

const jwt = (payload: object): string =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'assinatura'].join('.')

// Mesmo formato que o agy grava no Cofre de Credenciais (oauth2.Token do Go + id_token).
function credential(expiry: string): string {
  return JSON.stringify({
    token: { access_token: FAKE_TOKEN, token_type: 'Bearer', refresh_token: FAKE_REFRESH, expiry },
    auth_method: 'consumer',
    id_token: jwt({ email: 'pessoa@example.com' })
  })
}

const VALID = credential('2026-11-16T00:15:00.1522063-03:00')

function source(raw: string | null, version: string | null = '1.5.9'): AntigravitySource {
  return { readCredential: () => raw, version: async () => version }
}

interface Call {
  url: string
  init?: RequestInit
}

function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init })
    return respond()
  }
  return { fetch: impl as typeof fetch, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('parse do retrieveUserQuotaSummary', () => {
  it('converte o que resta em usado, por grupo, com o Gemini primeiro e a janela de 5 h antes da semanal', () => {
    const windows = parseAntigravityUsage(realSummary, NOW)
    expect(windows.map((w) => [w.label, w.windowMinutes, w.resetsAt])).toEqual([
      ['5 h · Gemini', 300, Date.parse('2026-11-16T06:52:15Z')],
      ['Semanal · Gemini', 10080, Date.parse('2026-11-23T01:52:15Z')],
      ['5 h · Claude e GPT', 300, Date.parse('2026-11-16T07:11:02Z')],
      ['Semanal · Claude e GPT', 10080, Date.parse('2026-11-23T02:11:02Z')],
      ['Semanal · Gemini 4 Argon', 10080, Date.parse('2026-11-23T02:11:02Z')]
    ])
    // remainingFraction 0.9233084 e 0.9723738 no fixture: 7,67% e 2,76% usados.
    expect(windows[0]!.usedPercent).toBeCloseTo(7.669, 2)
    expect(windows[1]!.usedPercent).toBeCloseTo(2.763, 2)
    expect(windows.slice(2).map((w) => w.usedPercent)).toEqual([0, 0, 0])
  })

  it('limite esgotado vira 100% usado; bucket sem fração, desativado ou sem janela fica de fora', () => {
    const windows = parseAntigravityUsage(
      {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { window: '5h', remainingFraction: 0, resetTime: '2026-11-16T04:00:00Z' },
              { window: 'weekly', remainingAmount: '12', resetTime: '2026-11-20T00:00:00Z' },
              { window: 'daily', remainingFraction: 0.5, disabled: true },
              { remainingFraction: 0.5 }
            ]
          }
        ]
      },
      NOW
    )
    expect(windows).toEqual([{ label: '5 h · Gemini', usedPercent: 100, resetsAt: Date.parse('2026-11-16T04:00:00Z'), windowMinutes: 300 }])
  })

  it('lança UsageFormatError quando nada é reconhecível', () => {
    expect(() => parseAntigravityUsage({ erro: 'x' }, NOW)).toThrow(UsageFormatError)
    expect(() => parseAntigravityUsage({ groups: [{ displayName: 'Gemini', buckets: [] }] }, NOW)).toThrow(UsageFormatError)
  })
})

describe('readAntigravityUsage', () => {
  it('manda o token só ao endpoint do Google, como o CLI instalado, sem seguir redirecionamento, e não o devolve', async () => {
    const f = fakeFetch(() => json(realSummary))
    const usage = await readAntigravityUsage(source(VALID, '1.6.2'), NOW, { fetch: f.fetch })
    expect(f.calls).toHaveLength(1)
    const [call] = f.calls
    expect(call!.url).toBe(ANTIGRAVITY_USAGE_URL)
    expect(new URL(ANTIGRAVITY_USAGE_URL).host).toBe('daily-cloudcode-pa.googleapis.com')
    expect(call!.init?.method).toBe('POST')
    expect(call!.init?.redirect).toBe('error')
    const headers = call!.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${FAKE_TOKEN}`)
    expect(headers['User-Agent']).toMatch(/^antigravity\/cli\/1\.6\.2 /)
    expect(usage).toMatchObject({ agent: 'antigravity', account: 'pessoa@example.com', updatedAt: NOW })
    expect(usage?.windows).toHaveLength(5)
    const shown = JSON.stringify(usage)
    expect(shown).not.toContain(FAKE_TOKEN)
    expect(shown).not.toContain(FAKE_REFRESH)
  })

  it('sem login do agy nesta máquina: nada aparece e nenhuma consulta sai', async () => {
    const f = fakeFetch(() => json(realSummary))
    expect(await readAntigravityUsage(source(null), NOW, { fetch: f.fetch })).toBeNull()
    expect(f.calls).toHaveLength(0)
  })

  it('sem login ativo mas com contas guardadas no Kora: o bloco fica, sem consulta, para escolher uma', async () => {
    const f = fakeFetch(() => json(realSummary))
    const usage = await readAntigravityUsage({ ...source(null), hasSavedAccounts: () => true }, NOW, { fetch: f.fetch })
    expect(f.calls).toHaveLength(0)
    expect(usage).toMatchObject({ agent: 'antigravity', windows: [], credentialsExpired: true })
    expect(usage?.error).toMatch(/Nenhuma conta ativa no agy/)
  })

  it('mostra a conta do formato do agy 1.5.13, que grava só id_token_email', async () => {
    const f = fakeFetch(() => json(realSummary))
    const raw = JSON.stringify({
      token: { access_token: FAKE_TOKEN, token_type: 'Bearer', refresh_token: FAKE_REFRESH, expiry: '2026-11-16T00:15:00-03:00', expires_in: 3599 },
      auth_method: 'consumer',
      id_token_email: 'nova@example.com'
    })
    const usage = await readAntigravityUsage(source(raw, '1.5.13'), NOW, { fetch: f.fetch })
    expect(usage).toMatchObject({ agent: 'antigravity', account: 'nova@example.com' })
  })

  it('token vencido não vai para a rede e pede para abrir o agy', async () => {
    const f = fakeFetch(() => json(realSummary))
    const usage = await readAntigravityUsage(source(credential('2026-11-15T23:00:00-03:00')), NOW, { fetch: f.fetch })
    expect(f.calls).toHaveLength(0)
    expect(usage).toMatchObject({ agent: 'antigravity', windows: [], credentialsExpired: true, account: 'pessoa@example.com' })
    expect(usage?.error).toMatch(/venceu; abra o agy/)
  })

  it('data zero do Go é token sem validade: consulta normalmente', async () => {
    const f = fakeFetch(() => json(realSummary))
    const usage = await readAntigravityUsage(source(credential('0001-01-01T00:00:00Z')), NOW, { fetch: f.fetch })
    expect(f.calls).toHaveLength(1)
    expect(usage?.windows).toHaveLength(5)
  })

  it('sem a versão do agy não consulta: com versão errada o servidor esconderia o grupo Gemini', async () => {
    const f = fakeFetch(() => json(realSummary))
    const usage = await readAntigravityUsage(source(VALID, null), NOW, { fetch: f.fetch })
    expect(f.calls).toHaveLength(0)
    expect(usage?.error).toMatch(/versão do agy/)
  })

  it('credencial ilegível vira erro visível, sem consulta', async () => {
    const f = fakeFetch(() => json(realSummary))
    for (const raw of ['{corrompido', JSON.stringify({ token: {} })]) {
      const usage = await readAntigravityUsage(source(raw), NOW, { fetch: f.fetch })
      expect(usage).toMatchObject({ agent: 'antigravity', windows: [], error: 'Login do agy em formato desconhecido' })
    }
    expect(f.calls).toHaveLength(0)
  })

  it('401 pede para abrir o agy; 429 marca o recuo com o Retry-After', async () => {
    const denied = await readAntigravityUsage(source(VALID), NOW, { fetch: fakeFetch(() => json({}, 401)).fetch })
    expect(denied?.error).toMatch(/HTTP 401\); abra o agy/)
    expect(denied?.rateLimited).toBeUndefined()
    const limited = await readAntigravityUsage(source(VALID), NOW, {
      fetch: fakeFetch(() => json({}, 429, { 'retry-after': '120' })).fetch
    })
    expect(limited?.rateLimited).toEqual({ retryAfterMs: 120_000 })
  })
})

describe('leitor: Antigravity', () => {
  it('aparece por último e é consultado no máximo 1x a cada 2 min; sem a fonte, não aparece', async () => {
    const empty = (): string => mkdtempSync(join(tmpdir(), 'kora-usage-agy-'))
    const f = fakeFetch(() => json(realSummary))
    let clock = NOW
    const reader = createUsageReader({
      claudeRoot: empty(),
      codexRoot: empty(),
      antigravity: source(VALID),
      fetch: f.fetch,
      now: () => clock
    })
    const first = await reader.read()
    expect(first.map((u) => [u.agent, u.nextCheckAt])).toEqual([['antigravity', NOW + 2 * MIN]])
    clock = NOW + 2 * MIN - 1_000
    await reader.read()
    expect(f.calls).toHaveLength(1)
    clock = NOW + 2 * MIN
    await reader.read()
    expect(f.calls).toHaveLength(2)

    const without = createUsageReader({ claudeRoot: empty(), codexRoot: empty(), fetch: f.fetch, now: () => NOW + HOUR })
    expect(await without.read()).toEqual([])
  })
})
