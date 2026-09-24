import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { formatResetAt, windowLabel } from '../shared/usage-format'
import type { AgentUsage, UsageWindow } from '../shared/usage-types'

const MINUTE = 60_000
const WEEK_MS = 7 * 24 * 60 * MINUTE
// O Codex é leitura de arquivo local; o Claude é uma API que devolve 429 se consultada demais.
export const CODEX_MIN_INTERVAL_MS = MINUTE
export const CLAUDE_MIN_INTERVAL_MS = 5 * MINUTE
export const BACKOFF_START_MS = 10 * MINUTE
export const BACKOFF_MAX_MS = 60 * MINUTE

// Janela passada: o limite já zerou e a próxima só começa no próximo uso, então não há hora de reset a mostrar.
function normalizeWindow(
  label: string,
  usedPercent: number,
  resetsAt: number | null,
  windowMinutes: number | null,
  now: number
): UsageWindow {
  const expired = resetsAt !== null && resetsAt <= now
  return {
    label,
    usedPercent: expired ? 0 : Math.min(100, Math.max(0, usedPercent)),
    resetsAt: expired ? null : resetsAt,
    windowMinutes
  }
}

// ───────────────────────────── Codex ─────────────────────────────

const CodexWindowSchema = z.object({
  used_percent: z.number(),
  window_minutes: z.number().int().positive().nullish(),
  resets_at: z.number().nullish(),
  resets_in_seconds: z.number().nullish()
})

const CodexRateLimitsSchema = z.object({
  limit_id: z.string().nullish(),
  limit_name: z.string().nullish(),
  primary: CodexWindowSchema.nullish(),
  secondary: CodexWindowSchema.nullish()
})

const TokenCountEventSchema = z.object({
  timestamp: z.string().refine((t) => Number.isFinite(Date.parse(t))),
  payload: z.object({ type: z.literal('token_count'), rate_limits: CodexRateLimitsSchema.nullish() })
})

type CodexWindow = z.infer<typeof CodexWindowSchema>

export interface CodexSnapshot {
  at: number
  limitId: string
  limitName: string | null
  primary: CodexWindow | null
  secondary: CodexWindow | null
}

export interface CodexParse {
  snapshots: CodexSnapshot[]
  unrecognized: number
}

/** Extrai os eventos token_count com rate_limits de um trecho de rollout-*.jsonl (linhas cortadas são ignoradas). */
export function parseCodexRateLimits(text: string): CodexParse {
  const snapshots: CodexSnapshot[] = []
  let unrecognized = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const payloadType = (raw as { payload?: { type?: unknown } } | null)?.payload?.type
    if (payloadType !== 'token_count') continue
    const parsed = TokenCountEventSchema.safeParse(raw)
    if (!parsed.success) {
      unrecognized++
      continue
    }
    const limits = parsed.data.payload.rate_limits
    if (!limits) continue
    snapshots.push({
      at: Date.parse(parsed.data.timestamp),
      limitId: limits.limit_id ?? 'codex',
      limitName: limits.limit_name ?? null,
      primary: limits.primary ?? null,
      secondary: limits.secondary ?? null
    })
  }
  return { snapshots, unrecognized }
}

/** Cada token_count traz um único limit_id (o geral ou o de um modelo); guarda o mais recente de cada. */
export function latestByLimit(snapshots: CodexSnapshot[]): CodexSnapshot[] {
  const latest = new Map<string, CodexSnapshot>()
  for (const s of snapshots) {
    const current = latest.get(s.limitId)
    if (!current || s.at > current.at) latest.set(s.limitId, s)
  }
  return [...latest.values()]
}

export function codexWindows(snapshots: CodexSnapshot[], now: number): UsageWindow[] {
  // O limite geral (sem nome) vem primeiro; os de modelo depois, em ordem alfabética.
  const ordered = latestByLimit(snapshots).sort((a, b) => (a.limitName ?? '').localeCompare(b.limitName ?? ''))
  const windows: UsageWindow[] = []
  for (const s of ordered) {
    for (const w of [s.primary, s.secondary]) {
      if (!w) continue
      const minutes = w.window_minutes ?? null
      const resetsAt =
        w.resets_at != null ? w.resets_at * 1000 : w.resets_in_seconds != null ? s.at + w.resets_in_seconds * 1000 : null
      const base = windowLabel(minutes)
      windows.push(normalizeWindow(s.limitName ? `${base} · ${s.limitName}` : base, w.used_percent, resetsAt, minutes, now))
    }
  }
  return windows
}

const CODEX_TAIL_BYTES = 256 * 1024
const CODEX_TAIL_MAX_BYTES = 4 * 1024 * 1024
const CODEX_MAX_DAY_DIRS = 30
const CODEX_MAX_FILES = 50

async function readTail(file: string, bytes: number): Promise<{ text: string; whole: boolean }> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return { text: buffer.toString('utf8'), whole: length === size }
  } finally {
    await handle.close()
  }
}

// O fim do arquivo quase sempre tem um token_count; só cresce a janela se um bloco grande (saída de ferramenta) o empurrou.
async function codexFileSnapshots(file: string): Promise<CodexParse> {
  for (let bytes = CODEX_TAIL_BYTES; ; bytes *= 4) {
    const { text, whole } = await readTail(file, bytes)
    const parsed = parseCodexRateLimits(text)
    if (parsed.snapshots.length > 0 || parsed.unrecognized > 0 || whole || bytes >= CODEX_TAIL_MAX_BYTES) {
      return { snapshots: latestByLimit(parsed.snapshots), unrecognized: parsed.unrecognized }
    }
  }
}

const descendingDirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

// A pasta YYYY/MM/DD é o dia em que a sessão começou; uma sessão longa segue escrevendo dias depois, por isso a
// ordem final é pelo mtime e não pelo nome.
async function recentRollouts(codexRoot: string, now: number): Promise<{ path: string; mtimeMs: number; size: number }[]> {
  const sessions = join(codexRoot, 'sessions')
  const dayDirs: string[] = []
  outer: for (const year of await descendingDirs(sessions)) {
    for (const month of await descendingDirs(join(sessions, year))) {
      for (const day of await descendingDirs(join(sessions, year, month))) {
        dayDirs.push(join(sessions, year, month, day))
        if (dayDirs.length >= CODEX_MAX_DAY_DIRS) break outer
      }
    }
  }
  const files: { path: string; mtimeMs: number; size: number }[] = []
  for (const dir of dayDirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      try {
        const s = await stat(join(dir, name))
        files.push({ path: join(dir, name), mtimeMs: s.mtimeMs, size: s.size })
      } catch {
        // arquivo removido entre o readdir e o stat
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  // Nenhuma janela do Codex passa de uma semana: arquivo parado há mais que isso não tem limite vigente.
  const active = files.filter((f) => now - f.mtimeMs <= WEEK_MS)
  return (active.length > 0 ? active : files.slice(0, 1)).slice(0, CODEX_MAX_FILES)
}

const codexFileCache = new Map<string, { mtimeMs: number; size: number; parse: CodexParse }>()

export async function readCodexUsage(codexRoot: string, now = Date.now()): Promise<AgentUsage | null> {
  const files = await recentRollouts(codexRoot, now)
  if (files.length === 0) return null
  const snapshots: CodexSnapshot[] = []
  let unrecognized = 0
  for (const f of files) {
    let cached = codexFileCache.get(f.path)
    if (!cached || cached.mtimeMs !== f.mtimeMs || cached.size !== f.size) {
      try {
        cached = { mtimeMs: f.mtimeMs, size: f.size, parse: await codexFileSnapshots(f.path) }
        codexFileCache.set(f.path, cached)
      } catch {
        continue
      }
    }
    snapshots.push(...cached.parse.snapshots)
    unrecognized += cached.parse.unrecognized
  }
  const source = 'Codex local (~/.codex/sessions)'
  if (snapshots.length === 0) {
    if (unrecognized === 0) return null
    return {
      agent: 'codex',
      windows: [],
      updatedAt: now,
      source,
      error: `Formato de rate_limits do Codex não reconhecido (${unrecognized} evento${unrecognized > 1 ? 's' : ''})`
    }
  }
  return {
    agent: 'codex',
    windows: codexWindows(snapshots, now),
    updatedAt: Math.max(...snapshots.map((s) => s.at)),
    source
  }
}

// ───────────────────────────── Claude ─────────────────────────────

// Único destino do token OAuth do usuário. Mesmo endpoint que o Claude Code consulta para o /usage.
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_TIMEOUT_MS = 10_000

const CredentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1), expiresAt: z.number().nullish() })
})

const ResetSchema = z.union([z.string(), z.number()]).nullish()

const ClaudeLimitSchema = z.object({
  kind: z.string(),
  percent: z.number(),
  resets_at: ResetSchema,
  scope: z.object({ model: z.object({ display_name: z.string().nullish() }).nullish() }).nullish()
})

const ClaudeLegacyWindowSchema = z.object({ utilization: z.number(), resets_at: ResetSchema })

const ClaudeUsageSchema = z.object({
  limits: z.array(z.unknown()).nullish(),
  five_hour: ClaudeLegacyWindowSchema.nullish(),
  seven_day: ClaudeLegacyWindowSchema.nullish(),
  seven_day_opus: ClaudeLegacyWindowSchema.nullish(),
  seven_day_sonnet: ClaudeLegacyWindowSchema.nullish()
})

function epochMs(value: string | number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 1e11 ? value * 1000 : value) : null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export class UsageFormatError extends Error {}

/** Converte a resposta de /api/oauth/usage; lança UsageFormatError se nada nela for reconhecível. */
export function parseClaudeUsage(json: unknown, now: number): UsageWindow[] {
  const parsed = ClaudeUsageSchema.safeParse(json)
  if (!parsed.success) throw new UsageFormatError('Resposta de uso do Claude em formato desconhecido')
  const data = parsed.data

  const windows: UsageWindow[] = []
  for (const item of data.limits ?? []) {
    const limit = ClaudeLimitSchema.safeParse(item)
    if (!limit.success) continue
    const { kind, percent, resets_at, scope } = limit.data
    const resetsAt = epochMs(resets_at)
    if (kind === 'session') windows.push(normalizeWindow('5 h', percent, resetsAt, 300, now))
    else if (kind === 'weekly_all') windows.push(normalizeWindow('Semanal', percent, resetsAt, 10080, now))
    else if (kind === 'weekly_scoped') {
      const model = scope?.model?.display_name?.trim()
      windows.push(normalizeWindow(model ? `Semanal · ${model}` : 'Semanal (escopo)', percent, resetsAt, 10080, now))
    } else windows.push(normalizeWindow(kind, percent, resetsAt, null, now))
  }
  if (windows.length > 0) return windows

  // Formato anterior ao array `limits`, que a API ainda devolve em paralelo.
  const legacy: [string, number, z.infer<typeof ClaudeLegacyWindowSchema> | null | undefined][] = [
    ['5 h', 300, data.five_hour],
    ['Semanal', 10080, data.seven_day],
    ['Semanal · Opus', 10080, data.seven_day_opus],
    ['Semanal · Sonnet', 10080, data.seven_day_sonnet]
  ]
  for (const [label, minutes, w] of legacy) {
    if (w) windows.push(normalizeWindow(label, w.utilization, epochMs(w.resets_at), minutes, now))
  }
  if (windows.length === 0) throw new UsageFormatError('Resposta de uso do Claude sem nenhuma janela reconhecível')
  return windows
}

export class ClaudeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null = null
  ) {
    super(`HTTP ${status}`)
  }
}

/** Retry-After em segundos ou como data HTTP; null se ausente ou ilegível. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/**
 * Única função que envia o token OAuth para a rede: GET em CLAUDE_USAGE_URL com `Authorization: Bearer`.
 * `redirect: 'error'` impede que um redirecionamento leve o token a outro host.
 */
export async function fetchClaudeUsageJson(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS)
  })
  if (!res.ok) throw new ClaudeHttpError(res.status, parseRetryAfter(res.headers.get('retry-after'), Date.now()))
  return await res.json()
}

function claudeErrorMessage(err: unknown): string {
  if (err instanceof UsageFormatError) return err.message
  if (err instanceof ClaudeHttpError) {
    if (err.status === 401 || err.status === 403)
      return `Login do Claude recusado (HTTP ${err.status}); abra o Claude Code para renovar`
    if (err.status === 429) return 'api.anthropic.com limitou as consultas de uso (HTTP 429)'
    return `api.anthropic.com respondeu HTTP ${err.status}`
  }
  // Só o nome do erro: a mensagem de falhas de rede não é nossa e não vale arriscar que carregue cabeçalhos.
  const name = err instanceof Error ? err.name : 'erro'
  return `Sem resposta de api.anthropic.com (${name})`
}

export interface ClaudeDeps {
  fetch?: typeof fetch
  now?: number
}

// Só circula no main: o leitor usa para decidir quando tentar de novo e tira antes de mandar à interface.
export interface ClaudeRead extends AgentUsage {
  rateLimited?: { retryAfterMs: number | null }
}

/** null quando não há login OAuth do Claude Code nesta máquina (sem .credentials.json). */
export async function readClaudeUsage(claudeRoot: string, deps: ClaudeDeps = {}): Promise<ClaudeRead | null> {
  const now = deps.now ?? Date.now()
  const source = 'api.anthropic.com/api/oauth/usage'
  const fail = (error: string): AgentUsage => ({ agent: 'claude', windows: [], updatedAt: now, source, error })

  let rawCredentials: string
  try {
    rawCredentials = await readFile(join(claudeRoot, '.credentials.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('Não foi possível ler as credenciais do Claude Code')
  }
  let credentials: z.infer<typeof CredentialsSchema>['claudeAiOauth']
  try {
    const parsed = CredentialsSchema.safeParse(JSON.parse(rawCredentials))
    if (!parsed.success) return null
    credentials = parsed.data.claudeAiOauth
  } catch {
    return fail('Credenciais do Claude Code em formato desconhecido')
  }
  // Não renovamos o token: o refresh troca o refresh_token e deixaria o Claude Code com um token revogado.
  if (credentials.expiresAt != null && credentials.expiresAt <= now) {
    return fail('Login do Claude expirado; abra o Claude Code para renovar')
  }

  try {
    const json = await fetchClaudeUsageJson(credentials.accessToken, deps.fetch)
    return { agent: 'claude', windows: parseClaudeUsage(json, now), updatedAt: now, source }
  } catch (err) {
    const failed: ClaudeRead = fail(claudeErrorMessage(err))
    if (err instanceof ClaudeHttpError && err.status === 429) failed.rateLimited = { retryAfterMs: err.retryAfterMs }
    return failed
  }
}

// ───────────────────────────── Leitor com throttle ─────────────────────────────

export interface CachedSlot {
  nextAt: number
  failures: number
  value: AgentUsage | null
}

// Guarda quando cada agente pode ser consultado de novo: reabrir o Kora não vira uma consulta nova.
export interface UsageCache {
  load(): Record<string, CachedSlot>
  save(slots: Record<string, CachedSlot>): void
}

export interface UsageReaderDeps {
  claudeRoot: string
  codexRoot: string
  fetch?: typeof fetch
  now?: () => number
  cache?: UsageCache
  timeZone?: string
}

interface Slot extends CachedSlot {
  inflight: Promise<AgentUsage | null> | null
}

const INTERVAL: Record<AgentUsage['agent'], number> = { claude: CLAUDE_MIN_INTERVAL_MS, codex: CODEX_MIN_INTERVAL_MS }

export function backoffMs(failures: number, retryAfterMs: number | null): number {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, failures - 1))
  return retryAfterMs === null ? exponential : Math.min(BACKOFF_MAX_MS, Math.max(retryAfterMs, CLAUDE_MIN_INTERVAL_MS))
}

/**
 * Cada agente é consultado no máximo 1x por intervalo (5 min o Claude, 1 min o Codex), por mais que a UI peça,
 * inclusive o botão de atualizar; chamadas simultâneas compartilham a mesma consulta. Depois de um 429 a próxima
 * consulta respeita o Retry-After ou recua de 10 min até 1 h. Se uma consulta falhar, as janelas anteriores
 * continuam visíveis com o erro anexado.
 */
export function createUsageReader(deps: UsageReaderDeps): { read(): Promise<AgentUsage[]> } {
  const now = deps.now ?? Date.now
  let slots: Map<string, Slot> | null = null
  const loaded = (): Map<string, Slot> => {
    if (slots) return slots
    slots = new Map()
    try {
      for (const [key, slot] of Object.entries(deps.cache?.load() ?? {})) slots.set(key, { ...slot, inflight: null })
    } catch {
      // Cache ilegível: começa do zero, o intervalo mínimo continua valendo daqui em diante.
    }
    return slots
  }
  const persist = (): void => {
    try {
      deps.cache?.save(Object.fromEntries([...loaded()].map(([k, { nextAt, failures, value }]) => [k, { nextAt, failures, value }])))
    } catch {
      // Sem cache em disco o limite vale só enquanto o processo roda.
    }
  }

  const throttled = (key: AgentUsage['agent'], load: () => Promise<ClaudeRead | null>): Promise<AgentUsage | null> => {
    const map = loaded()
    const slot = map.get(key)
    if (slot?.inflight) return slot.inflight
    if (slot && now() < slot.nextAt) return Promise.resolve(slot.value)
    const previous = slot?.value ?? null
    const inflight = load()
      .catch((err: unknown): ClaudeRead | null => ({
        agent: key,
        windows: [],
        updatedAt: now(),
        source: key,
        error: `Falha ao ler o uso (${err instanceof Error ? err.name : 'erro'})`
      }))
      .then((result) => {
        const at = now()
        const { rateLimited, ...next } = result ?? ({} as ClaudeRead)
        const failures = rateLimited ? (slot?.failures ?? 0) + 1 : 0
        const nextAt = at + (rateLimited ? backoffMs(failures, rateLimited.retryAfterMs) : INTERVAL[key])
        let value: AgentUsage | null = result === null ? null : next
        if (value && rateLimited) value = { ...value, error: `${value.error}; nova consulta ${formatResetAt(nextAt, at, deps.timeZone)}` }
        if (value?.error && value.windows.length === 0 && previous && previous.windows.length > 0) {
          value = { ...previous, error: value.error }
        }
        map.set(key, { nextAt, failures, value, inflight: null })
        persist()
        return value
      })
    map.set(key, { nextAt: slot?.nextAt ?? 0, failures: slot?.failures ?? 0, value: previous, inflight })
    return inflight
  }

  return {
    async read() {
      const results = await Promise.all([
        throttled('claude', () => readClaudeUsage(deps.claudeRoot, { fetch: deps.fetch, now: now() })),
        throttled('codex', () => readCodexUsage(deps.codexRoot, now()))
      ])
      return results.filter((r): r is AgentUsage => r !== null)
    }
  }
}
