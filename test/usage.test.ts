import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_USAGE_URL,
  backoffMs,
  createUsageReader,
  parseRetryAfter,
  type CachedSlot,
  type UsageCache,
  parseClaudeUsage,
  parseCodexRateLimits,
  readClaudeUsage,
  readCodexUsage,
  UsageFormatError
} from '../src/main/usage'
import { formatRemaining, formatResetAt, isCritical, mostConstrained } from '../src/shared/usage-format'

const NOW = Date.parse('2026-09-24T14:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const sec = (ms: number): number => Math.floor(ms / 1000)

// ───────────── fixtures do Codex (formato real do rollout-*.jsonl, Codex CLI set/2026) ─────────────

interface CodexWin {
  used_percent: number
  window_minutes: number
  resets_at?: number
  resets_in_seconds?: number
}

function tokenCount(
  at: number,
  primary: CodexWin | null,
  opts: { limitId?: string; limitName?: string | null; secondary?: CodexWin | null } = {}
): object {
  return {
    timestamp: new Date(at).toISOString(),
    ordinal: 1,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 1000, cached_input_tokens: 900, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 5, total_tokens: 1010 },
        last_token_usage: { input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 101 },
        model_context_window: 258400
      },
      rate_limits: {
        limit_id: opts.limitId ?? 'codex',
        limit_name: opts.limitName ?? null,
        primary,
        secondary: opts.secondary ?? null,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: 'pro',
        rate_limit_reached_type: null
      }
    }
  }
}

const weekly = (used: number, resetsAt = NOW + 5 * DAY + 8 * HOUR): CodexWin => ({
  used_percent: used,
  window_minutes: 10080,
  resets_at: sec(resetsAt)
})

const otherLine = (at: number): object => ({
  timestamp: new Date(at).toISOString(),
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }
})

const jsonl = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

let codexRoot: string
let claudeRoot: string

function writeRollout(day: string, name: string, body: string, mtime: number): string {
  const dir = join(codexRoot, 'sessions', ...day.split('/'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${name}.jsonl`)
  writeFileSync(file, body, 'utf8')
  utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}

beforeEach(() => {
  codexRoot = mkdtempSync(join(tmpdir(), 'kora-usage-codex-'))
  claudeRoot = mkdtempSync(join(tmpdir(), 'kora-usage-claude-'))
})

describe('parse dos eventos token_count do Codex', () => {
  it('extrai limit_id, janelas e horário; ignora outras linhas, rate_limits nulo e linha cortada', () => {
    const text =
      '{"timestamp":"2026-09-24T13:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_li' + // cortada pelo início da janela
      '\n' +
      jsonl(
        otherLine(NOW - HOUR),
        { timestamp: new Date(NOW - 30 * MIN).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } },
        tokenCount(NOW - 10 * MIN, weekly(78))
      )
    const { snapshots, unrecognized } = parseCodexRateLimits(text)
    expect(unrecognized).toBe(0)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ at: NOW - 10 * MIN, limitId: 'codex', limitName: null, secondary: null })
    expect(snapshots[0]!.primary).toMatchObject({ used_percent: 78, window_minutes: 10080 })
  })

  it('conta como não reconhecido um token_count com rate_limits num formato diferente', () => {
    const bad = tokenCount(NOW, null) as { payload: { rate_limits: Record<string, unknown> } }
    bad.payload.rate_limits['primary'] = { used_percent: '78%', window_minutes: 10080 }
    expect(parseCodexRateLimits(jsonl(bad))).toEqual({ snapshots: [], unrecognized: 1 })
  })
})

describe('readCodexUsage', () => {
  it('usa o token_count mais recente entre arquivos e dentro do arquivo', async () => {
    writeRollout('2026/09/23', 'a', jsonl(tokenCount(NOW - 3 * HOUR, weekly(60)), tokenCount(NOW - 2 * HOUR, weekly(65))), NOW - 2 * HOUR)
    writeRollout('2026/09/24', 'b', jsonl(tokenCount(NOW - 50 * MIN, weekly(70)), tokenCount(NOW - 5 * MIN, weekly(78)), otherLine(NOW - 4 * MIN)), NOW - 4 * MIN)
    const usage = await readCodexUsage(codexRoot, NOW)
    expect(usage?.windows).toEqual([
      { label: 'Semanal', usedPercent: 78, resetsAt: sec(NOW + 5 * DAY + 8 * HOUR) * 1000, windowMinutes: 10080 }
    ])
    expect(usage?.updatedAt).toBe(NOW - 5 * MIN)
    expect(usage?.error).toBeUndefined()
  })

  it('segue a sessão longa pelo mtime mesmo quando a pasta do dia é antiga', async () => {
    // Sessão aberta dia 10 e ainda ativa; a de hoje parou antes.
    writeRollout('2026/09/24', 'hoje', jsonl(tokenCount(NOW - 2 * HOUR, weekly(40))), NOW - 2 * HOUR)
    writeRollout('2026/09/10', 'longa', jsonl(tokenCount(NOW - MIN, weekly(81))), NOW - MIN)
    const usage = await readCodexUsage(codexRoot, NOW)
    expect(usage?.windows[0]?.usedPercent).toBe(81)
  })

  it('mostra o limite geral e o de cada modelo, cada um pelo seu evento mais recente', async () => {
    const spark = (used5h: number, usedWeek: number, at: number): object =>
      tokenCount(at, { used_percent: used5h, window_minutes: 300, resets_at: sec(NOW + 3 * HOUR + 8 * MIN) }, {
        limitId: 'codex_bengalfox',
        limitName: 'GPT-5.3-Codex-Spark',
        secondary: { used_percent: usedWeek, window_minutes: 10080, resets_at: sec(NOW + 6 * DAY) }
      })
    const premium = tokenCount(NOW - 20 * MIN, null, { limitId: 'premium' })
    writeRollout(
      '2026/09/24',
      'c',
      jsonl(spark(1, 2, NOW - 40 * MIN), spark(5, 7, NOW - 30 * MIN), premium, tokenCount(NOW - 10 * MIN, weekly(74))),
      NOW - 10 * MIN
    )
    const usage = await readCodexUsage(codexRoot, NOW)
    expect(usage?.windows.map((w) => [w.label, w.usedPercent, w.windowMinutes])).toEqual([
      ['Semanal', 74, 10080],
      ['5 h · GPT-5.3-Codex-Spark', 5, 300],
      ['Semanal · GPT-5.3-Codex-Spark', 7, 10080]
    ])
  })

  it('zera a janela cujo reset já passou e mantém a que ainda vai resetar', async () => {
    writeRollout(
      '2026/09/24',
      'd',
      jsonl(
        tokenCount(NOW - 6 * HOUR, { used_percent: 90, window_minutes: 300, resets_at: sec(NOW - MIN) }, {
          secondary: { used_percent: 30, window_minutes: 10080, resets_at: sec(NOW + DAY) }
        })
      ),
      NOW - 6 * HOUR
    )
    const usage = await readCodexUsage(codexRoot, NOW)
    expect(usage?.windows).toEqual([
      { label: '5 h', usedPercent: 0, resetsAt: null, windowMinutes: 300 },
      { label: 'Semanal', usedPercent: 30, resetsAt: sec(NOW + DAY) * 1000, windowMinutes: 10080 }
    ])
  })

  it('aceita resets_in_seconds (contado a partir do horário do evento)', async () => {
    writeRollout(
      '2026/09/24',
      'e',
      jsonl(tokenCount(NOW - HOUR, { used_percent: 12, window_minutes: 300, resets_in_seconds: 2 * 3600 })),
      NOW - HOUR
    )
    const usage = await readCodexUsage(codexRoot, NOW)
    expect(usage?.windows[0]).toMatchObject({ usedPercent: 12, resetsAt: NOW + HOUR })
  })

  it('acha o token_count mesmo quando um bloco grande no fim do arquivo o empurra para fora da primeira janela', async () => {
    const huge = { ...otherLine(NOW - MIN), blob: 'x'.repeat(600 * 1024) }
    writeRollout('2026/09/24', 'f', jsonl(tokenCount(NOW - 2 * MIN, weekly(55)), huge), NOW - MIN)
    const usage = await readCodexUsage(codexRoot, NOW)
    expect(usage?.windows[0]?.usedPercent).toBe(55)
  })

  it('devolve erro claro, sem lançar, quando o formato de rate_limits é desconhecido', async () => {
    const bad = tokenCount(NOW, null) as { payload: { rate_limits: Record<string, unknown> } }
    bad.payload.rate_limits['primary'] = { percent: 10 }
    writeRollout('2026/09/24', 'g', jsonl(bad), NOW - MIN)
    const usage = await readCodexUsage(codexRoot, NOW)
    expect(usage).toMatchObject({ agent: 'codex', windows: [] })
    expect(usage?.error).toMatch(/não reconhecido/)
  })

  it('devolve null sem pasta de sessões', async () => {
    expect(await readCodexUsage(join(codexRoot, 'nao-existe'), NOW)).toBeNull()
  })
})

// ───────────── fixtures do Claude (resposta real de /api/oauth/usage, set/2026, valores trocados) ─────────────

const legacyWindow = (utilization: number, resets_at: string | null): object => ({
  utilization,
  resets_at,
  limit_dollars: null,
  used_dollars: null,
  remaining_dollars: null,
  locked_reason: null
})

const FIVE_H_RESET = '2026-09-24T15:19:59.948114+00:00'
const WEEK_RESET = '2026-09-30T23:59:59.948156+00:00'

const claudeResponse = (): Record<string, unknown> => ({
  five_hour: legacyWindow(30, FIVE_H_RESET),
  seven_day: legacyWindow(13, WEEK_RESET),
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: legacyWindow(0, null),
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [
    { kind: 'session', group: 'plan', percent: 30, severity: 'normal', resets_at: FIVE_H_RESET, scope: null, is_active: true },
    { kind: 'weekly_all', group: 'plan', percent: 13, severity: 'normal', resets_at: WEEK_RESET, scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'plan',
      percent: 10,
      severity: 'normal',
      resets_at: '2026-09-30T23:59:59.948457+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false
    }
  ],
  member_dashboard_available: false
})

const FAKE_TOKEN = 'FAKE-oauth-token-0123456789'

function writeCredentials(expiresAt: number | null = NOW + 5 * HOUR): void {
  writeFileSync(
    join(claudeRoot, '.credentials.json'),
    JSON.stringify({
      mcpOAuth: {},
      claudeAiOauth: {
        accessToken: FAKE_TOKEN,
        refreshToken: 'FAKE-refresh-token',
        expiresAt,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x'
      }
    }),
    'utf8'
  )
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init })
    return respond()
  }
  return { fetch: impl as typeof fetch, calls }
}

const ok = (body: unknown = claudeResponse()): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('parse da resposta de uso do Claude', () => {
  it('lê o array limits: 5 h, semanal e semanal por modelo, com o reset em microssegundos', () => {
    expect(parseClaudeUsage(claudeResponse(), NOW)).toEqual([
      { label: '5 h', usedPercent: 30, resetsAt: Date.parse('2026-09-24T15:19:59.948Z'), windowMinutes: 300 },
      { label: 'Semanal', usedPercent: 13, resetsAt: Date.parse('2026-09-30T23:59:59.948Z'), windowMinutes: 10080 },
      { label: 'Semanal · Fable', usedPercent: 10, resetsAt: Date.parse('2026-09-30T23:59:59.948Z'), windowMinutes: 10080 }
    ])
  })

  it('cai para five_hour/seven_day quando não há limits', () => {
    const body = claudeResponse()
    delete body['limits']
    expect(parseClaudeUsage(body, NOW).map((w) => [w.label, w.usedPercent])).toEqual([
      ['5 h', 30],
      ['Semanal', 13]
    ])
  })

  it('zera a janela cujo reset já passou', () => {
    const body = claudeResponse()
    ;(body['limits'] as Record<string, unknown>[])[0]!['resets_at'] = new Date(NOW - MIN).toISOString()
    expect(parseClaudeUsage(body, NOW)[0]).toEqual({ label: '5 h', usedPercent: 0, resetsAt: null, windowMinutes: 300 })
  })

  it('lança UsageFormatError para formato desconhecido', () => {
    expect(() => parseClaudeUsage({ usage: { pct: 3 } }, NOW)).toThrow(UsageFormatError)
    expect(() => parseClaudeUsage('html', NOW)).toThrow(UsageFormatError)
  })
})

describe('readClaudeUsage', () => {
  it('envia o token só para api.anthropic.com, sem seguir redirecionamento, e não o devolve', async () => {
    writeCredentials()
    const f = fakeFetch(() => ok())
    const usage = await readClaudeUsage(claudeRoot, { fetch: f.fetch, now: NOW })
    expect(f.calls).toHaveLength(1)
    const url = new URL(f.calls[0]!.url)
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('api.anthropic.com')
    expect(url.pathname).toBe('/api/oauth/usage')
    expect(f.calls[0]!.init?.redirect).toBe('error')
    expect(new Headers(f.calls[0]!.init?.headers).get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
    expect(usage?.windows.map((w) => w.usedPercent)).toEqual([30, 13, 10])
    expect(JSON.stringify(usage)).not.toContain('FAKE')
  })

  it('traduz 401 em mensagem acionável sem vazar o token', async () => {
    writeCredentials()
    const f = fakeFetch(() => new Response(`{"error":"invalid token ${FAKE_TOKEN}"}`, { status: 401 }))
    const usage = await readClaudeUsage(claudeRoot, { fetch: f.fetch, now: NOW })
    expect(usage?.windows).toEqual([])
    expect(usage?.error).toMatch(/HTTP 401/)
    expect(JSON.stringify(usage)).not.toContain('FAKE')
  })

  it('falha de rede vira erro, nunca exceção, e não repete a mensagem do erro', async () => {
    writeCredentials()
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed Authorization: Bearer ${FAKE_TOKEN}`)
    })
    const usage = await readClaudeUsage(claudeRoot, { fetch: f.fetch, now: NOW })
    expect(usage?.error).toMatch(/Sem resposta de api\.anthropic\.com/)
    expect(JSON.stringify(usage)).not.toContain('FAKE')
  })

  it('resposta em formato desconhecido vira erro claro', async () => {
    writeCredentials()
    const usage = await readClaudeUsage(claudeRoot, { fetch: fakeFetch(() => ok({ foo: 1 })).fetch, now: NOW })
    expect(usage?.error).toMatch(/formato desconhecido|nenhuma janela/)
  })

  it('não chama a rede com o token expirado', async () => {
    writeCredentials(NOW - MIN)
    const f = fakeFetch(() => ok())
    const usage = await readClaudeUsage(claudeRoot, { fetch: f.fetch, now: NOW })
    expect(f.calls).toHaveLength(0)
    expect(usage?.error).toMatch(/expirado/)
  })

  it('devolve null sem credenciais, sem chamar a rede', async () => {
    const f = fakeFetch(() => ok())
    expect(await readClaudeUsage(claudeRoot, { fetch: f.fetch, now: NOW })).toBeNull()
    expect(f.calls).toHaveLength(0)
  })

  it('usa a URL oficial exportada', () => {
    expect(new URL(CLAUDE_USAGE_URL).host).toBe('api.anthropic.com')
  })
})

describe('leitor com throttle', () => {
  const memoryCache = (): UsageCache & { data: Record<string, CachedSlot> } => {
    const cache = {
      data: {} as Record<string, CachedSlot>,
      load: () => structuredClone(cache.data),
      save: (slots: Record<string, CachedSlot>) => {
        cache.data = structuredClone(slots)
      }
    }
    return cache
  }

  it('Claude no máximo 1x a cada 5 min e Codex 1x por minuto, inclusive com chamadas simultâneas', async () => {
    writeCredentials(NOW + DAY)
    writeRollout('2026/09/24', 'h', jsonl(tokenCount(NOW - MIN, weekly(10))), NOW - MIN)
    const f = fakeFetch(() => ok())
    let clock = NOW
    const reader = createUsageReader({ claudeRoot, codexRoot, fetch: f.fetch, now: () => clock })
    const [a] = await Promise.all([reader.read(), reader.read()])
    expect(a?.map((u) => u.agent)).toEqual(['claude', 'codex'])
    expect(f.calls).toHaveLength(1)
    clock += 5 * MIN - 1_000
    await reader.read()
    expect(f.calls).toHaveLength(1)
    clock += 2_000
    await reader.read()
    expect(f.calls).toHaveLength(2)
  })

  it('reabrir o app (leitor novo com o mesmo cache) não consulta de novo antes do intervalo', async () => {
    writeCredentials(NOW + DAY)
    const f = fakeFetch(() => ok())
    const cache = memoryCache()
    let clock = NOW
    await createUsageReader({ claudeRoot, codexRoot, fetch: f.fetch, now: () => clock, cache }).read()
    clock += MIN
    const [claude] = await createUsageReader({ claudeRoot, codexRoot, fetch: f.fetch, now: () => clock, cache }).read()
    expect(f.calls).toHaveLength(1)
    expect(claude?.windows.map((w) => w.usedPercent)).toEqual([30, 13, 10])
  })

  it('429 sem Retry-After recua 10 min, depois 20 min; mantém as janelas anteriores e diz quando tenta de novo', async () => {
    writeCredentials(NOW + DAY)
    let status = 200
    const f = fakeFetch(() => (status === 200 ? ok() : new Response('', { status })))
    let clock = NOW
    const reader = createUsageReader({ claudeRoot, codexRoot, fetch: f.fetch, now: () => clock, timeZone: 'America/Sao_Paulo' })
    await reader.read()
    status = 429
    clock += 5 * MIN
    const [claude] = await reader.read()
    expect(f.calls).toHaveLength(2)
    expect(claude?.windows.map((w) => w.usedPercent)).toEqual([30, 13, 10])
    expect(claude?.updatedAt).toBe(NOW)
    expect(claude?.error).toMatch(/429.*nova consulta hoje às 11:15/)
    expect(claude).not.toHaveProperty('rateLimited')

    clock += 10 * MIN - 1_000
    await reader.read()
    expect(f.calls).toHaveLength(2)
    clock += 1_000
    await reader.read()
    expect(f.calls).toHaveLength(3)
    clock += 20 * MIN - 1_000
    await reader.read()
    expect(f.calls).toHaveLength(3)
    status = 200
    clock += 1_000
    const [recovered] = await reader.read()
    expect(f.calls).toHaveLength(4)
    expect(recovered?.error).toBeUndefined()
  })

  it('429 com Retry-After espera o que o servidor pediu (com piso de 5 min e teto de 1 h)', async () => {
    expect(backoffMs(1, 30 * MIN)).toBe(30 * MIN)
    expect(backoffMs(1, 1_000)).toBe(5 * MIN)
    expect(backoffMs(1, 5 * HOUR)).toBe(HOUR)
    expect(backoffMs(9, null)).toBe(HOUR)
    expect(parseRetryAfter('120', NOW)).toBe(120_000)
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000)
    expect(parseRetryAfter(null, NOW)).toBeNull()
    expect(parseRetryAfter('amanhã', NOW)).toBeNull()

    writeCredentials(NOW + DAY)
    const f = fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '1800' } }))
    let clock = NOW
    const reader = createUsageReader({ claudeRoot, codexRoot, fetch: f.fetch, now: () => clock })
    await reader.read()
    clock += 30 * MIN - 1_000
    await reader.read()
    expect(f.calls).toHaveLength(1)
    clock += 1_000
    await reader.read()
    expect(f.calls).toHaveLength(2)
  })
})

describe('formatação', () => {
  it('tempo restante nas duas maiores unidades', () => {
    expect(formatRemaining(3 * HOUR + 8 * MIN + 30_000)).toBe('3h 8m')
    expect(formatRemaining(6 * DAY + 11 * HOUR + 59 * MIN)).toBe('6d 11h')
    expect(formatRemaining(12 * MIN)).toBe('12m')
    expect(formatRemaining(2 * HOUR)).toBe('2h')
    expect(formatRemaining(30_000)).toBe('<1m')
    expect(formatRemaining(-1)).toBe('agora')
  })

  it('hora do reset em pt-BR, relativa a hoje e amanhã', () => {
    const tz = 'America/Sao_Paulo'
    expect(formatResetAt(Date.parse('2026-09-24T15:20:00Z'), NOW, tz)).toBe('hoje às 12:20')
    expect(formatResetAt(Date.parse('2026-09-25T15:20:00Z'), NOW, tz)).toBe('amanhã às 12:20')
    expect(formatResetAt(Date.parse('2026-09-30T23:59:00Z'), NOW, tz)).toMatch(/^qua\.?, 30\/09 às 20:59$/)
  })

  it('crítico só acima de 80% e janela mais apertada pelo maior uso', () => {
    expect(isCritical(80)).toBe(false)
    expect(isCritical(81)).toBe(true)
    const w = (usedPercent: number, resetsAt: number | null): { label: string; usedPercent: number; resetsAt: number | null; windowMinutes: null } => ({
      label: String(usedPercent),
      usedPercent,
      resetsAt,
      windowMinutes: null
    })
    expect(mostConstrained([w(5, 1), w(74, 2), w(7, 3)])?.usedPercent).toBe(74)
    expect(mostConstrained([w(10, 1), w(10, 9)])?.resetsAt).toBe(9)
    expect(mostConstrained([])).toBeNull()
  })
})
