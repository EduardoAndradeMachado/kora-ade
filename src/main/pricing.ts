// Preços de API em US$ por milhão de tokens, para estimar quanto a conversa custaria fora da assinatura.
// Fonte: tabela de modelos da Anthropic (out/2026) e tabela pública da OpenAI (out/2026). Modelo fora da tabela
// fica sem estimativa em vez de herdar o preço de outro.

interface ClaudeRate {
  input: number
  output: number
  cacheRead: number
  context: number
  // Prompt acima de longFrom tokens cobra a tabela long (só o Haiku 5.5 tem essa faixa).
  long?: { from: number; input: number; output: number; cacheRead: number }
  // Modo rápido com preço publicado; nos demais o custo fica no preço padrão.
  fastMultiplier?: number
}

const M = 1_000_000

const CLAUDE: Record<string, ClaudeRate> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, context: M },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, context: M },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, context: M },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, context: M, fastMultiplier: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, context: M, fastMultiplier: 2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, context: M },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, context: M },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, context: M },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, context: M },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, context: M },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, context: M },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    context: M,
    long: { from: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 }
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, context: 200_000 }
}

// IDs chegam com sufixo de data (claude-haiku-4-5-20251001) ou de variante ([1m]).
const normalizeClaude = (model: string): string => model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')

export interface ClaudeUsage {
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  output: number
  fast: boolean
}

export function claudeCost(model: string, u: ClaudeUsage): number | null {
  const rate = CLAUDE[normalizeClaude(model)]
  if (!rate) return null
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  const r = rate.long && prompt > rate.long.from ? { ...rate, ...rate.long } : rate
  const speed = u.fast ? (rate.fastMultiplier ?? 1) : 1
  // Gravação de cache: 1,25x a entrada para 5 minutos, 2x para 1 hora.
  const usd =
    u.input * r.input +
    u.cacheWrite5m * r.input * 1.25 +
    u.cacheWrite1h * r.input * 2 +
    u.cacheRead * r.cacheRead +
    u.output * r.output
  return (usd * speed) / M
}

export const claudeContextWindow = (model: string): number | null => CLAUDE[normalizeClaude(model)]?.context ?? null

interface OpenAiRate {
  input: number
  cached: number
  cacheWrite: number
  output: number
  long: { from: number; input: number; cached: number; cacheWrite: number; output: number }
}

const OPENAI: Record<string, OpenAiRate> = {
  'gpt-6.1-sol': {
    input: 2,
    cached: 0.1,
    cacheWrite: 2.5,
    output: 10,
    long: { from: 272_000, input: 4, cached: 0.2, cacheWrite: 5, output: 15 }
  },
  'gpt-6.1-terra': {
    input: 1,
    cached: 0.05,
    cacheWrite: 1.25,
    output: 5,
    long: { from: 272_000, input: 2, cached: 0.1, cacheWrite: 2.5, output: 7.5 }
  },
  'gpt-6-astra': {
    input: 10,
    cached: 1,
    cacheWrite: 12.5,
    output: 50,
    long: { from: 272_000, input: 20, cached: 2, cacheWrite: 25, output: 75 }
  },
  'gpt-6-sol': {
    input: 2,
    cached: 0.2,
    cacheWrite: 2.5,
    output: 10,
    long: { from: 272_000, input: 4, cached: 0.4, cacheWrite: 5, output: 15 }
  },
  'gpt-6-luna': {
    input: 0.1,
    cached: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    long: { from: 272_000, input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 0.75 }
  }
}

export interface OpenAiUsage {
  // Como a OpenAI reporta: input inclui o cache lido e o gravado; output inclui o raciocínio.
  input: number
  cached: number
  cacheWrite: number
  output: number
}

export function codexCost(model: string, u: OpenAiUsage): number | null {
  const rate = OPENAI[model]
  if (!rate) return null
  const r = u.input > rate.long.from ? rate.long : rate
  const fresh = Math.max(0, u.input - u.cached - u.cacheWrite)
  return (fresh * r.input + u.cached * r.cached + u.cacheWrite * r.cacheWrite + u.output * r.output) / M
}
