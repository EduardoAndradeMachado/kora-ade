import type { AgentKind } from './agent'

// Comandos "/" de cada agente para o menu do celular. Os que abrem um seletor ou painel no terminal (interactive)
// não aparecem no modo leitura: mandar um deles leva o celular para o terminal, onde dá para escolher. Fora do Claude,
// nenhum agente grava a resposta dos comandos na conversa, então todo comando leva ao terminal.
export interface AgentCommand {
  name: string
  description: string
  interactive?: boolean
  // Valores que completam o comando sem abrir seletor (ex.: /model opus).
  options?: string[]
}

const CLAUDE: AgentCommand[] = [
  { name: '/model', description: 'Trocar o modelo', options: ['opus', 'sonnet', 'haiku', 'fable'] },
  { name: '/effort', description: 'Nível de raciocínio', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { name: '/compact', description: 'Resumir a conversa para liberar contexto' },
  { name: '/clear', description: 'Começar uma conversa nova nesta aba' },
  { name: '/context', description: 'Ver o uso do contexto' },
  { name: '/plan', description: 'Entrar no modo de planejamento' },
  { name: '/fast', description: 'Ligar ou desligar o modo rápido' },
  { name: '/init', description: 'Criar o CLAUDE.md do projeto' },
  { name: '/usage', description: 'Limites de uso da conta', interactive: true },
  { name: '/resume', description: 'Retomar outra conversa', interactive: true },
  { name: '/rewind', description: 'Voltar a um ponto anterior', interactive: true },
  { name: '/permissions', description: 'Permissões de ferramentas', interactive: true },
  { name: '/config', description: 'Configurações', interactive: true },
  { name: '/agents', description: 'Subagentes', interactive: true },
  { name: '/memory', description: 'Editar a memória', interactive: true }
]

const CODEX: AgentCommand[] = [
  { name: '/model', description: 'Trocar o modelo e o raciocínio', interactive: true },
  { name: '/approvals', description: 'O que o Codex pode fazer sem perguntar', interactive: true },
  { name: '/new', description: 'Começar uma conversa nova' },
  { name: '/compact', description: 'Resumir a conversa para liberar contexto' },
  { name: '/diff', description: 'Ver as mudanças do git' },
  { name: '/status', description: 'Configuração e uso da sessão' },
  { name: '/review', description: 'Revisar as mudanças atuais', interactive: true },
  { name: '/init', description: 'Criar o AGENTS.md do projeto' }
]

const OPENCODE: AgentCommand[] = [
  { name: '/models', description: 'Trocar o modelo', interactive: true },
  { name: '/new', description: 'Começar uma sessão nova' },
  { name: '/compact', description: 'Resumir a conversa para liberar contexto' },
  { name: '/help', description: 'Ajuda e atalhos', interactive: true }
]

const AGY: AgentCommand[] = [
  { name: '/model', description: 'Trocar o modelo', interactive: true },
  { name: '/effort', description: 'Nível de raciocínio', interactive: true },
  { name: '/compact', description: 'Resumir a conversa para liberar contexto' },
  { name: '/clear', description: 'Começar uma conversa nova' },
  { name: '/plan', description: 'Entrar no modo de planejamento' },
  { name: '/add-dir', description: 'Dar acesso a outra pasta (caminho completo)' },
  { name: '/resume', description: 'Retomar outra conversa', interactive: true },
  { name: '/rewind', description: 'Voltar a um ponto anterior', interactive: true },
  { name: '/skills', description: 'Ver as skills', interactive: true },
  { name: '/help', description: 'Ajuda e atalhos', interactive: true }
]

export function agentCommands(kind: AgentKind): AgentCommand[] {
  if (kind === 'claude') return CLAUDE
  if (kind === 'codex') return CODEX
  if (kind === 'opencode') return OPENCODE
  if (kind === 'antigravity') return AGY
  return []
}

// Se a resposta ao texto mandado só aparece no terminal. No Claude, só a primeira palavra decide ("/model opus" não
// abre seletor, "/model" abre); nos outros agentes, qualquer comando de barra.
export function opensTerminal(kind: AgentKind, text: string): boolean {
  const [name, ...rest] = text.trim().split(/\s+/)
  if (kind !== 'claude') return name !== undefined && name.length > 1 && name.startsWith('/')
  const command = agentCommands(kind).find((c) => c.name === name)
  if (!command) return false
  return command.interactive === true || (command.options !== undefined && rest.length === 0)
}
