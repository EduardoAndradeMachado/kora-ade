// O modo leitura do celular: a conversa do agente lida do que ele grava no PC, em vez da tela do terminal.

export type TranscriptItem =
  | { kind: 'user'; id: string; at: string; text: string; images: number; truncated: boolean }
  | { kind: 'assistant'; id: string; at: string; text: string; truncated: boolean }
  | { kind: 'tool'; id: string; at: string; toolId: string; name: string; summary: string }
  | { kind: 'result'; id: string; at: string; toolId: string; text: string; error: boolean; truncated: boolean }
  | { kind: 'note'; id: string; at: string; text: string }
  // Fim de um turno do agente, com quanto ele trabalhou ("Worked for 8s" no Claude).
  | { kind: 'turn'; id: string; at: string; durationMs: number | null }

// O que a barra do modo leitura mostra. Cada campo só vem quando o agente grava a informação.
export interface TranscriptStatus {
  model?: string
  // Nível de raciocínio pedido (low, medium, high…), como o agente grava.
  effort?: string
  // Modo de permissão ou aprovação (bypassPermissions, plan, on-request…), como o agente grava.
  mode?: string
  // Contexto enviado na última resposta e a janela do modelo, em tokens.
  contextTokens?: number
  contextWindow?: number
}

// start e end são cursores opacos para o celular: ele só devolve o que recebeu. Para ver mais antigas, pede
// before=start; para as novas, after=end. Cada agente decide o que o número é (posição em bytes no .jsonl, ordem
// da mensagem no banco). reset: o cursor pedido não vale mais (arquivo reescrito, conversa apagada), recomece do fim.
export interface TranscriptPage {
  sessionId: string
  items: TranscriptItem[]
  start: number
  end: number
  atStart: boolean
  reset?: boolean
  status?: TranscriptStatus
}

export interface TranscriptEvent { sessionId: string }

export const TRANSCRIPT_PAGE_MAX = 80
