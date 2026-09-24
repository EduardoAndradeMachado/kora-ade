export interface UsageWindow {
  label: string
  usedPercent: number
  /** epoch ms; null quando não há reset pendente (janela já zerou ou nunca foi usada). */
  resetsAt: number | null
  windowMinutes: number | null
}

export type UsageAgent = 'claude' | 'codex'

export interface AgentUsage {
  agent: UsageAgent
  windows: UsageWindow[]
  /** epoch ms do momento a que o dado se refere (último evento do Codex, última consulta do Claude). */
  updatedAt: number
  source: string
  error?: string
}
