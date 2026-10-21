import type { AgentKind } from './agent'

// Métrica que o agente não grava: o painel mostra DESATIVADO e o motivo no hover.
export interface Off {
  off: string
}
export type Metric<T> = T | Off

export const off = (reason: string): Off => ({ off: reason })
export const isOff = (value: unknown): value is Off =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'off' in value

// Uma resposta do modelo (uma chamada à API). O Claude e o Codex fazem várias por turno, entre ferramentas.
export interface ResponseMetric {
  // Fim da resposta, em ms.
  at: number
  model: string
  // Entrada sem cache; cache lido e gravado vêm à parte.
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  // Tokens gerados, incluindo os de raciocínio.
  outputTokens: number
  // Tamanho do contexto enviado nesta chamada (entrada + cache).
  contextTokens: number
  // Do envio do pedido ao fim da resposta: inclui a espera pelo primeiro token.
  durationMs: number | null
  tps: number | null
  costUsd: Metric<number>
}

export interface SessionMetrics {
  agent: AgentKind
  sessionId: string
  responses: ResponseMetric[]
  // Respostas dos subagentes lançados pela conversa (e pelos subagentes deles), cada um com o próprio modelo.
  subagentResponses: ResponseMetric[]
  // Pedidos feitos ao agente (cada um dispara uma ou mais respostas do modelo).
  turns: number
  // O custo do OpenCode vem gravado; o do Claude e do Codex é estimado pela tabela de preços da API.
  costKind: 'real' | 'estimado'
  contextWindow: Metric<number>
  interruptions: number
  subagents: number
  compactions: number
}

export interface DayPoint {
  at: number
  agent: AgentKind
  model: string
  tps: number
  outputTokens: number
}
