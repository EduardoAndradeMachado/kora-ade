// Último limite semanal geral visto enquanto a conta estava ativa: conta guardada não é consultada.
export interface WeeklyUsage {
  usedPercent: number
  resetsAt: number | null
  recordedAt: number
}

// O que a interface vê das contas do Claude: nenhum token sai do main.
export interface ClaudeAccount {
  id: string
  email: string
  organizationName: string | null
  subscriptionType: string | null
  // Depois disso o login da conta não renova mais e precisa de um /login novo.
  refreshTokenExpiresAt: number | null
  weekly: WeeklyUsage | null
  active: boolean
}

export type ClaudeLogin = { state: 'running'; url: string | null } | { state: 'failed'; message: string } | null

export interface ClaudeAccountsView {
  accounts: ClaudeAccount[]
  // Há login no Claude Code, mas não deu para saber de qual conta (sem rede ou login vencido que o Kora não conhece).
  activeUnknown: boolean
  login: ClaudeLogin
}
