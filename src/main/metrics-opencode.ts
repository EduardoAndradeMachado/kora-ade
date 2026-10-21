import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { off, type DayPoint, type ResponseMetric, type SessionMetrics } from '../shared/metrics'
import { queryOpencode } from './opencode'

interface MessageRow {
  type: string
  data: string
}

interface AssistantData {
  time?: { created?: number; streamed?: number; completed?: number }
  model?: { id?: string; providerID?: string }
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

const MIN_TPS_MS = 250
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// Mesma conta da TUI do OpenCode: tokens gerados ÷ (fim do streaming − criação da mensagem).
function generation(d: AssistantData): { durationMs: number | null; tps: number | null; generated: number } {
  const generated = num(d.tokens?.output) + num(d.tokens?.reasoning)
  const end = d.time?.streamed ?? d.time?.completed
  const durationMs = d.time?.created && end ? end - d.time.created : null
  return {
    durationMs,
    generated,
    tps: durationMs !== null && durationMs >= MIN_TPS_MS && generated > 0 ? generated / (durationMs / 1000) : null
  }
}

// Catálogo de modelos (models.dev) que o próprio OpenCode mantém em cache: dá a janela de contexto por provedor.
let catalog: { file: string; mtimeMs: number; data: Record<string, { models?: Record<string, { limit?: { context?: number } }> }> } | null = null

function contextWindowOf(provider: string, model: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const cacheRoot = env['XDG_CACHE_HOME']?.trim() || join(homedir(), '.cache')
  const file = join(cacheRoot, 'opencode', 'models.json')
  try {
    const { mtimeMs } = statSync(file)
    if (!catalog || catalog.file !== file || catalog.mtimeMs !== mtimeMs) {
      catalog = { file, mtimeMs, data: JSON.parse(readFileSync(file, 'utf8')) as NonNullable<typeof catalog>['data'] }
    }
  } catch {
    return null
  }
  const context = catalog.data[provider]?.models?.[model]?.limit?.context
  return typeof context === 'number' && context > 0 ? context : null
}

function response(d: AssistantData): ResponseMetric {
  const t = d.tokens
  const { durationMs, tps, generated } = generation(d)
  return {
    at: d.time?.completed ?? d.time?.streamed ?? num(d.time?.created),
    model: d.model?.id ?? 'desconhecido',
    inputTokens: num(t?.input),
    cacheReadTokens: num(t?.cache?.read),
    cacheWriteTokens: num(t?.cache?.write),
    outputTokens: generated,
    contextTokens: num(t?.input) + num(t?.cache?.read) + num(t?.cache?.write),
    durationMs,
    tps,
    costUsd: typeof d.cost === 'number' ? d.cost : off('O OpenCode não gravou o custo desta mensagem.')
  }
}

const messagesOf = (dbFile: string, sessionId: string): MessageRow[] =>
  queryOpencode<MessageRow>(dbFile, 'session_message', 'select type, data from session_message where session_id = ? order by seq', [sessionId]) ?? []

// O subagente do OpenCode é uma sessão filha (parent_id); um subagente pode lançar outro.
function descendants(dbFile: string, sessionId: string): string[] {
  const found: string[] = []
  const queue = [sessionId]
  while (queue.length > 0) {
    const parent = queue.shift()!
    const children = queryOpencode<{ id: string }>(dbFile, 'session_v2', 'select id from session_v2 where parent_id = ?', [parent]) ?? []
    for (const { id } of children) {
      if (found.includes(id) || id === sessionId) continue
      found.push(id)
      queue.push(id)
    }
  }
  return found
}

export function opencodeMetrics(dbFile: string, sessionId: string): SessionMetrics {
  const rows = messagesOf(dbFile, sessionId)
  const children = descendants(dbFile, sessionId)
  const subagentResponses: ResponseMetric[] = []
  for (const child of children) {
    for (const row of messagesOf(dbFile, child)) {
      if (row.type !== 'assistant') continue
      try {
        subagentResponses.push(response(JSON.parse(row.data) as AssistantData))
      } catch {
        // mensagem corrompida não derruba as outras
      }
    }
  }
  subagentResponses.sort((a, b) => a.at - b.at)

  const responses: ResponseMetric[] = []
  let turns = 0
  let interruptions = 0
  let compactions = 0
  let lastModel: { provider: string; id: string } | null = null

  for (const row of rows) {
    let d: AssistantData & { outcome?: string }
    try {
      d = JSON.parse(row.data) as typeof d
    } catch {
      continue
    }
    if (row.type === 'user') {
      turns++
      continue
    }
    if (row.type === 'idle') {
      if (d.outcome === 'interrupted') interruptions++
      continue
    }
    if (row.type === 'compaction') {
      compactions++
      continue
    }
    if (row.type !== 'assistant') continue

    lastModel = { provider: d.model?.providerID ?? '', id: d.model?.id ?? 'desconhecido' }
    responses.push(response(d))
  }

  const window = lastModel ? contextWindowOf(lastModel.provider, lastModel.id) : null
  return {
    agent: 'opencode',
    sessionId,
    responses,
    subagentResponses,
    turns,
    costKind: 'real',
    contextWindow:
      window ??
      off(lastModel ? `${lastModel.provider}/${lastModel.id} não está no catálogo de modelos do OpenCode.` : 'Nenhuma resposta ainda.'),
    interruptions,
    subagents: children.length,
    compactions
  }
}

export function opencodeDay(dbFile: string, since: number): DayPoint[] {
  const rows =
    queryOpencode<{ data: string }>(
      dbFile,
      'session_message',
      "select data from session_message where type = 'assistant' and time_created >= ? order by time_created",
      [since]
    ) ?? []
  const points: DayPoint[] = []
  for (const row of rows) {
    let d: AssistantData
    try {
      d = JSON.parse(row.data) as AssistantData
    } catch {
      continue
    }
    const { tps, generated } = generation(d)
    if (tps === null) continue
    points.push({ at: d.time?.completed ?? num(d.time?.created), agent: 'opencode', model: d.model?.id ?? 'desconhecido', tps, outputTokens: generated })
  }
  return points
}
