import { z } from 'zod'

// Claude usa UUID v4 e o Codex UUID v7; os dois cabem no formato canônico.
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const AgentKindSchema = z.enum(['claude', 'codex'])
export type AgentKind = z.infer<typeof AgentKindSchema>

export const AgentSessionSchema = z.object({
  kind: AgentKindSchema,
  sessionId: z.string().regex(SESSION_ID),
  name: z.string().optional()
})
export type AgentSession = z.infer<typeof AgentSessionSchema>

// Estado do agente rodando na aba: trabalhando (respondendo) ou esperando você (parado no prompt ou pedindo permissão).
export type AgentActivity = 'working' | 'waiting'

export type Startup =
  | { kind: 'claude'; mode: 'new'; sessionId: string }
  | { kind: 'claude' | 'codex'; mode: 'resume'; sessionId: string }
  | { kind: 'codex'; mode: 'new' }

// Retorna o comando que o PowerShell roda ao abrir a aba. O ID vai direto na linha de comando,
// então só passa se tiver o formato de UUID.
export function startupCommand(startup: Startup): string {
  if ('sessionId' in startup && !SESSION_ID.test(startup.sessionId)) {
    throw new Error(`ID de sessão inválido: ${startup.sessionId}`)
  }
  if (startup.kind === 'claude') {
    return startup.mode === 'new' ? `claude --session-id ${startup.sessionId}` : `claude --resume ${startup.sessionId}`
  }
  // Desde o 0.157 o Codex sobe um servidor em segundo plano e é ele quem grava a conversa e segura o lock dela;
  // o Kora liga a aba à conversa pelo processo dono do lock, que precisa ser descendente da aba.
  return startup.mode === 'new' ? 'codex --no-daemon' : `codex resume ${startup.sessionId} --no-daemon`
}
