import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { AgentActivity } from '../shared/agent'

// O Claude grava em ~/.claude/sessions/<pid>.json o estado da tela: "busy" enquanto responde (ou com subagente em
// segundo plano), "waiting" quando pede permissão ou resposta, "idle" parado no prompt e "shell" parado no prompt
// com um comando em segundo plano ainda aberto (no código dele: idle && alguma tarefa local_bash não terminada).
// A tela do Claude mostra "shell" como working; aqui vale o que importa para o aviso: o turno acabou e ele
// espera você. Valor desconhecido fica sem indicador.
export function claudeActivity(status: unknown): AgentActivity | null {
  if (status === 'busy') return 'working'
  if (status === 'waiting' || status === 'idle' || status === 'shell') return 'waiting'
  return null
}

// Com subagente em segundo plano o status fica "busy" mesmo depois do turno encerrado, com o Claude parado
// esperando você (no código dele: isLoading || delegatedActive). O transcript diferencia: todo turno que termina
// sem interrupção grava a entrada system/turn_duration, e o turno seguinte começa com uma mensagem (seu pedido ou
// o aviso do subagente). Turno interrompido com Esc não grava a entrada e continua contando como trabalhando.
export function claudeTurnEnded(tail: string): boolean {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; subtype?: unknown }
    try {
      entry = JSON.parse(lines[i]!) as typeof entry
    } catch {
      continue
    }
    if (entry.type === 'user' || entry.type === 'assistant') return false
    if (entry.type === 'system' && entry.subtype === 'turn_duration') return true
  }
  return false
}

const TURN_EVENT =/"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted)"/g

// No rollout do Codex cada turno abre com task_started e fecha com task_complete ou turn_aborted.
// Um turno longo pode empurrar o início para fora do trecho lido; sem marcador nenhum, o turno ainda corre.
export function codexActivity(tail: string): AgentActivity {
  let last: string | null = null
  for (const match of tail.matchAll(TURN_EVENT)) last = match[1]!
  if (last === null) return 'working'
  return last === 'task_started' ? 'working' : 'waiting'
}

const TAIL_BYTES = 256 * 1024

// Rollout vazio (Codex aberto, sem mensagem ainda) não chega aqui: o vínculo só existe depois da primeira mensagem.
export function readTail(file: string, bytes = TAIL_BYTES): string {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
