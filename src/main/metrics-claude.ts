import { off, type ResponseMetric, type SessionMetrics } from '../shared/metrics'
import { claudeContextWindow, claudeCost } from './pricing'

type Entry = Record<string, unknown>

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  speed?: string
}

interface Pending {
  model: string
  requestRef: string | null
  // Reserva para quem não tem requestRef: o último evento (prompt ou resultado de ferramenta) antes da resposta.
  fallbackStart: number | null
  lastAt: number
  usage: Usage
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
const MIN_TPS_MS = 250
const LOCAL_COMMAND = /^\s*<(local-command-|command-name|command-message|bash-input|bash-stdout|task-notification)/

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const time = (e: Entry): number | null => {
  const t = typeof e['timestamp'] === 'string' ? Date.parse(e['timestamp']) : NaN
  return Number.isFinite(t) ? t : null
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  if (content.some((c) => (c as { type?: string }).type === 'tool_result')) return null
  return content.map((c) => ((c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).join(' ')
}

// Lê o transcript (~/.claude/projects/<pasta>/<sessão>.jsonl) linha a linha. Cada resposta da API vira várias
// linhas "assistant" com o mesmo message.id (uma por bloco); o uso final vem na última delas.
// O subagente grava num arquivo próprio (<sessão>/subagents/agent-*.jsonl) com todas as linhas marcadas como
// isSidechain; no arquivo da conversa principal essas linhas não são dela.
export class ClaudeMetrics {
  constructor(private readonly subagent = false) {}

  // Hora em que cada pedido saiu, pelo id. O Claude Code grava as linhas fora de ordem (o pedido da resposta
  // seguinte pode entrar antes da anterior), então o vínculo é pelo requestRef da resposta, não pela posição.
  private readonly requests = new Map<string, number>()
  private lastEventAt: number | null = null
  private readonly pending = new Map<string, Pending>()
  private turns = 0
  private interruptions = 0
  private subagents = 0
  private compactions = 0

  line(e: Entry): void {
    if (e['isSidechain'] === true && !this.subagent) return
    const at = time(e)
    if (at === null) return

    switch (e['type']) {
      case 'api-request':
        if (typeof e['id'] === 'string') this.requests.set(e['id'], at)
        return
      case 'assistant':
        this.assistant(e, at)
        return
      case 'user':
        this.user(e, at)
        return
      case 'system':
        if (e['subtype'] === 'compact_boundary') this.compactions++
        return
    }
  }

  private assistant(e: Entry, at: number): void {
    const message = e['message'] as { id?: string; model?: string; usage?: Usage; content?: unknown } | undefined
    if (!message || typeof message.model !== 'string' || message.model === '<synthetic>') return
    const id = message.id ?? String(e['uuid'])
    let p = this.pending.get(id)
    if (!p) {
      p = {
        model: message.model,
        requestRef: typeof e['requestRef'] === 'string' ? e['requestRef'] : null,
        fallbackStart: this.lastEventAt,
        lastAt: at,
        usage: {}
      }
      this.pending.set(id, p)
    }
    p.lastAt = Math.max(p.lastAt, at)
    if (message.usage) p.usage = message.usage
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const b = block as { type?: string; name?: string }
      if (b.type === 'tool_use' && typeof b.name === 'string' && SUBAGENT_TOOLS.has(b.name)) this.subagents++
    }
  }

  private user(e: Entry, at: number): void {
    this.lastEventAt = at
    if (e['isMeta'] === true || e['toolUseResult'] !== undefined) return
    const text = promptText((e['message'] as { content?: unknown } | undefined)?.content)
    if (text === null) return
    if (text.includes('[Request interrupted by user')) {
      this.interruptions++
      return
    }
    // Comando local (/model, /clear), comando de shell (!) e aviso de tarefa em segundo plano não são pedidos ao modelo.
    if (!text.trim() || LOCAL_COMMAND.test(text)) return
    this.turns++
  }

  snapshot(sessionId: string): SessionMetrics {
    const responses: ResponseMetric[] = [...this.pending.values()].map((p) => {
      const u = p.usage
      const write5m = num(u.cache_creation?.ephemeral_5m_input_tokens)
      const write1h = num(u.cache_creation?.ephemeral_1h_input_tokens)
      // Versões sem o detalhamento por duração gravam só o total, cobrado como 5 minutos.
      const writeTotal = num(u.cache_creation_input_tokens)
      const cacheWrite5m = write5m + write1h > 0 ? write5m : writeTotal
      const fast = u.speed === 'fast'
      const output = num(u.output_tokens)
      const startAt = (p.requestRef ? this.requests.get(p.requestRef) : undefined) ?? p.fallbackStart
      const elapsed = startAt !== null ? p.lastAt - startAt : null
      // Linha gravada fora de ordem pode deixar a reserva depois do fim; sem medida confiável, sem TPS.
      const durationMs = elapsed !== null && elapsed > 0 ? elapsed : null
      const cost = claudeCost(p.model, {
        input: num(u.input_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite5m,
        cacheWrite1h: write1h,
        output,
        fast
      })
      return {
        at: p.lastAt,
        model: p.model,
        inputTokens: num(u.input_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: cacheWrite5m + write1h,
        outputTokens: output,
        contextTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + cacheWrite5m + write1h,
        durationMs,
        tps: durationMs !== null && durationMs >= MIN_TPS_MS && output > 0 ? output / (durationMs / 1000) : null,
        costUsd: cost ?? off(`Sem preço de API para ${p.model} na tabela do Kora.`)
      }
    })
    const lastModel = responses.at(-1)?.model
    const window = lastModel ? claudeContextWindow(lastModel) : null
    return {
      agent: 'claude',
      sessionId,
      responses,
      subagentResponses: [],
      turns: this.turns,
      costKind: 'estimado',
      contextWindow: window ?? off(lastModel ? `Janela de ${lastModel} fora da tabela do Kora.` : 'Nenhuma resposta ainda.'),
      interruptions: this.interruptions,
      subagents: this.subagents,
      compactions: this.compactions
    }
  }
}
