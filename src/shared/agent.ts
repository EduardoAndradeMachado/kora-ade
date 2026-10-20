import { z } from 'zod'

// Claude usa UUID v4 e o Codex UUID v7; os dois cabem no formato canônico.
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// O OpenCode usa IDs próprios (ses_...). A CLI aceita retomar ou criar uma conversa com o ID informado;
// restringimos ao alfabeto seguro porque ele vai direto na linha de comando.
export const OPENCODE_SESSION_ID = /^ses[0-9a-z_-]{1,128}$/i

export const AgentKindSchema = z.enum(['claude', 'codex', 'opencode'])
export type AgentKind = z.infer<typeof AgentKindSchema>

export function validSessionId(kind: AgentKind, sessionId: string): boolean {
  return kind === 'opencode' ? OPENCODE_SESSION_ID.test(sessionId) : SESSION_ID.test(sessionId)
}

const agentFields = {
  kind: AgentKindSchema,
  sessionId: z.string().min(1).max(160)
}

function checkSessionId(value: { kind: AgentKind; sessionId: string }, ctx: z.RefinementCtx): void {
  if (!validSessionId(value.kind, value.sessionId)) {
    ctx.addIssue({ code: 'custom', path: ['sessionId'], message: `ID de sessão inválido para ${value.kind}` })
  }
}

export const AgentRefSchema = z.object(agentFields).superRefine(checkSessionId)
export type AgentRef = z.infer<typeof AgentRefSchema>

export const AgentSessionSchema = z.object({ ...agentFields, name: z.string().optional() }).superRefine(checkSessionId)
export type AgentSession = z.infer<typeof AgentSessionSchema>

// Estado do agente rodando na aba: trabalhando (respondendo) ou esperando você (parado no prompt ou pedindo permissão).
export type AgentActivity = 'working' | 'waiting'

export type Startup =
  | { kind: 'claude'; mode: 'new'; sessionId: string }
  | { kind: 'claude' | 'codex'; mode: 'resume'; sessionId: string }
  | { kind: 'codex'; mode: 'new' }
  | { kind: 'opencode'; mode: 'new' | 'resume'; sessionId: string }

// Retorna o comando que o PowerShell roda ao abrir a aba. O ID vai direto na linha de comando,
// então só passa se tiver o formato do agente.
export function startupCommand(startup: Startup): string {
  if ('sessionId' in startup && !validSessionId(startup.kind, startup.sessionId)) {
    throw new Error(`ID de sessão inválido: ${startup.sessionId}`)
  }
  if (startup.kind === 'claude') {
    return startup.mode === 'new' ? `claude --session-id ${startup.sessionId}` : `claude --resume ${startup.sessionId}`
  }
  if (startup.kind === 'opencode') {
    // --standalone: o servidor do OpenCode fica dentro da árvore da aba (e do Job Object do Kora),
    // em vez de compartilhar o serviço de segundo plano com o OpenCode aberto fora dele.
    return `opencode --standalone --session ${startup.sessionId}`
  }
  // Desde o 0.157 o Codex sobe um servidor em segundo plano e é ele quem grava a conversa e segura o lock dela;
  // o Kora liga a aba à conversa pelo processo dono do lock, que precisa ser descendente da aba.
  return startup.mode === 'new' ? 'codex --no-daemon' : `codex resume ${startup.sessionId} --no-daemon`
}
