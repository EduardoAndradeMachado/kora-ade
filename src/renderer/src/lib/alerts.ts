import type { AgentActivity } from '../../../shared/agent'

// Resposta curta não vira campainha: só avisa se o agente ficou trabalhando pelo menos isso.
export const MIN_WORK_MS = 3000

export interface Transition {
  previous: AgentActivity | null | undefined
  next: AgentActivity | null
  // Quando a aba entrou em "trabalhando"; null se não estava trabalhando.
  workingSince: number | null
  now: number
  // A aba está na tela e a janela tem o foco: você já está vendo, não precisa de aviso.
  watching: boolean
}

// A sessão acabou de parar (trabalhando → esperando você) depois de trabalhar um tempo, e você não está olhando.
export function finishedUnseen(t: Transition): boolean {
  return (
    t.previous === 'working' &&
    t.next === 'waiting' &&
    t.workingSince !== null &&
    t.now - t.workingSince >= MIN_WORK_MS &&
    !t.watching
  )
}
