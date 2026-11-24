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

// Cada lista saiu do menu "/" do próprio agente, lido no terminal dele (2026-11-24: Claude Code 2.1.331, Codex 0.171,
// OpenCode 2.3.2, agy 1.5.16); ficaram os comandos que fazem sentido pelo celular. Comando que não está no menu do
// agente não entra, mesmo que outro agente tenha: cada um tem os seus.
const CLAUDE: AgentCommand[] = [
  // Apelidos e níveis aceitos pelo próprio Claude Code (conferidos no executável).
  { name: '/model', description: 'Trocar o modelo', options: ['opus', 'sonnet', 'haiku', 'fable'] },
  { name: '/effort', description: 'Nível de raciocínio', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { name: '/compact', description: 'Resumir a conversa para liberar contexto' },
  { name: '/clear', description: 'Começar uma conversa nova nesta aba' },
  { name: '/context', description: 'Ver o uso do contexto' },
  { name: '/plan', description: 'Entrar no modo de planejamento' },
  { name: '/fast', description: 'Ligar ou desligar o modo rápido' },
  { name: '/btw', description: 'Pergunta paralela, sem interromper o trabalho' },
  { name: '/subtask', description: 'Mandar um subagente com o contexto da conversa' },
  { name: '/add-dir', description: 'Dar acesso a outra pasta (caminho completo)' },
  { name: '/init', description: 'Criar o CLAUDE.md do projeto' },
  { name: '/usage', description: 'Custo da sessão e uso do plano', interactive: true },
  { name: '/status', description: 'Versão, conta, modelo e servidores MCP', interactive: true },
  { name: '/tasks', description: 'Trabalho em segundo plano da sessão', interactive: true },
  { name: '/diff', description: 'Mudanças ainda não commitadas', interactive: true },
  { name: '/resume', description: 'Retomar outra conversa', interactive: true },
  { name: '/rewind', description: 'Voltar a um ponto anterior', interactive: true },
  { name: '/memory', description: 'Editar a memória', interactive: true },
  { name: '/permissions', description: 'Permissões de ferramentas', interactive: true },
  { name: '/skills', description: 'Ver as skills', interactive: true },
  { name: '/mcp', description: 'Servidores MCP', interactive: true },
  { name: '/config', description: 'Configurações', interactive: true },
  { name: '/help', description: 'Ajuda e comandos', interactive: true }
]

// Fora do Claude, todo comando vai ao terminal (opensTerminal): interactive não muda nada e fica de fora.
const CODEX: AgentCommand[] = [
  { name: '/model', description: 'Trocar o modelo e o raciocínio' },
  { name: '/permissions', description: 'O que o Codex pode fazer sem perguntar' },
  { name: '/new', description: 'Começar uma conversa nova' },
  { name: '/compact', description: 'Resumir a conversa para liberar contexto' },
  { name: '/recap', description: 'Resumir a conversa agora' },
  { name: '/plan', description: 'Entrar no modo de planejamento' },
  { name: '/fast', description: 'Modo rápido (2x, gasta mais)' },
  { name: '/goal', description: 'Definir o objetivo de uma tarefa longa' },
  { name: '/side', description: 'Conversa paralela' },
  { name: '/review', description: 'Revisar as mudanças atuais' },
  { name: '/diff', description: 'Ver as mudanças do git' },
  { name: '/status', description: 'Configuração e uso de tokens da sessão' },
  { name: '/usage', description: 'Uso da conta e limites' },
  { name: '/init', description: 'Criar o AGENTS.md do projeto' },
  { name: '/resume', description: 'Retomar outra conversa' },
  { name: '/fork', description: 'Bifurcar a conversa' },
  { name: '/rename', description: 'Renomear a conversa' },
  { name: '/skills', description: 'Usar skills' },
  { name: '/mcp', description: 'Ferramentas MCP' }
]

const OPENCODE: AgentCommand[] = [
  { name: '/models', description: 'Trocar o modelo' },
  { name: '/effort', description: 'Trocar a variante do modelo (raciocínio)' },
  { name: '/agents', description: 'Trocar o agente (build, plan…)' },
  { name: '/new', description: 'Começar uma sessão nova' },
  { name: '/clear', description: 'Limpar a sessão' },
  { name: '/btw', description: 'Pergunta paralela, sem entrar na conversa' },
  { name: '/goal', description: 'Trabalhar até cumprir um objetivo' },
  { name: '/review', description: 'Revisar as mudanças' },
  { name: '/diff', description: 'Ver as mudanças' },
  { name: '/init', description: 'Criar o AGENTS.md do projeto' },
  { name: '/sessions', description: 'Trocar de sessão' },
  { name: '/status', description: 'Ver o status' },
  { name: '/stats', description: 'Estatísticas de uso' },
  { name: '/skills', description: 'Skills' },
  { name: '/help', description: 'Ajuda' }
]

const AGY: AgentCommand[] = [
  { name: '/effort', description: 'Nível de raciocínio' },
  { name: '/clear', description: 'Começar uma conversa nova' },
  { name: '/plan', description: 'Planejar com cuidado antes de executar' },
  { name: '/goal', description: 'Trabalhar até cumprir um objetivo' },
  { name: '/btw', description: 'Pergunta paralela, sem interromper o trabalho' },
  { name: '/context', description: 'Ver o uso do contexto' },
  { name: '/usage', description: 'Cota de uso do modelo' },
  { name: '/diff', description: 'Mudanças não commitadas e por turno' },
  { name: '/add-dir', description: 'Dar acesso a outra pasta (caminho completo)' },
  { name: '/resume', description: 'Retomar outra conversa' },
  { name: '/rewind', description: 'Voltar a uma mensagem anterior' },
  { name: '/fork', description: 'Bifurcar a conversa' },
  { name: '/rename', description: 'Renomear a conversa' },
  { name: '/permissions', description: 'Permissões de ferramentas' },
  { name: '/skills', description: 'Ver as skills' },
  { name: '/help', description: 'Comandos e atalhos' }
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
