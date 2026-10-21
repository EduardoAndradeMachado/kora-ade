import { off, type ResponseMetric, type SessionMetrics } from '../shared/metrics'
import { codexCost } from './pricing'

type Entry = Record<string, unknown>

interface TokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
}

interface Raw {
  at: number
  startAt: number | null
  model: string
  usage: TokenUsage
}

const MIN_TPS_MS = 250
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const time = (e: Entry): number | null => {
  const t = typeof e['timestamp'] === 'string' ? Date.parse(e['timestamp']) : NaN
  return Number.isFinite(t) ? t : null
}

// Lê o rollout (~/.codex/sessions/AAAA/MM/DD/rollout-*-<thread>.jsonl). Cada chamada ao modelo grava um
// token_usage_record; versões que não gravam esse registro só têm o token_count, usado como reserva.
export class CodexMetrics {
  private model = ''
  private lastEventAt: number | null = null
  private readonly records: Raw[] = []
  private readonly counts: Raw[] = []
  private turns = 0
  private interruptions = 0
  private subagents = 0
  private compactions = 0
  private window: number | null = null

  line(e: Entry): void {
    const at = time(e)
    const p = (e['payload'] ?? {}) as Record<string, unknown>
    switch (e['type']) {
      case 'session_meta':
        if (num(p['context_window'])) this.window = num(p['context_window'])
        return
      case 'turn_context':
        if (typeof p['model'] === 'string') this.model = p['model']
        return
      case 'compacted':
        this.compactions++
        return
      case 'token_usage_record':
        if (at === null) return
        this.records.push(this.raw(at, (p['usage'] ?? {}) as TokenUsage))
        return
      case 'response_item':
        if (at !== null) this.responseItem(p, at)
        return
      case 'event_msg':
        if (at !== null) this.event(p, at)
        return
    }
  }

  private raw(at: number, usage: TokenUsage): Raw {
    const raw = { at, startAt: this.lastEventAt, model: this.model, usage }
    this.lastEventAt = at
    return raw
  }

  private responseItem(p: Record<string, unknown>, at: number): void {
    const type = p['type']
    if (type === 'function_call_output' || type === 'custom_tool_call_output') this.lastEventAt = at
    else if (type === 'message' && p['role'] === 'user') this.lastEventAt = at
    else if ((type === 'function_call' || type === 'custom_tool_call') && p['name'] === 'spawn_agent') this.subagents++
  }

  private event(p: Record<string, unknown>, at: number): void {
    switch (p['type']) {
      case 'task_started':
        this.lastEventAt = at
        this.turns++
        return
      case 'turn_aborted':
        this.interruptions++
        return
      case 'token_count': {
        const info = p['info'] as { last_token_usage?: TokenUsage; model_context_window?: number } | null | undefined
        if (info?.model_context_window) this.window = info.model_context_window
        if (info?.last_token_usage && this.records.length === 0) this.counts.push(this.raw(at, info.last_token_usage))
        return
      }
    }
  }

  snapshot(sessionId: string): SessionMetrics {
    const raws = this.records.length > 0 ? this.records : this.counts
    const responses: ResponseMetric[] = raws.map((r) => {
      const u = r.usage
      const input = num(u.input_tokens)
      const cached = num(u.cached_input_tokens)
      const cacheWrite = num(u.cache_write_input_tokens)
      const output = num(u.output_tokens)
      const durationMs = r.startAt !== null ? r.at - r.startAt : null
      const cost = codexCost(r.model, { input, cached, cacheWrite, output })
      return {
        at: r.at,
        model: r.model || 'desconhecido',
        inputTokens: Math.max(0, input - cached - cacheWrite),
        cacheReadTokens: cached,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        contextTokens: input,
        durationMs,
        tps: durationMs !== null && durationMs >= MIN_TPS_MS && output > 0 ? output / (durationMs / 1000) : null,
        costUsd: cost ?? off(`Sem preço de API para ${r.model || 'este modelo'} na tabela do Kora.`)
      }
    })
    return {
      agent: 'codex',
      sessionId,
      responses,
      subagentResponses: [],
      turns: this.turns,
      costKind: 'estimado',
      contextWindow: this.window ?? off('O rollout ainda não informou a janela de contexto.'),
      interruptions: this.interruptions,
      subagents: this.subagents,
      compactions: this.compactions
    }
  }
}
