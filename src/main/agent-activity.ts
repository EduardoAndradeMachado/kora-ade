import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { AgentActivity } from '../shared/agent'

// O Claude grava em ~/.claude/sessions/<pid>.json o estado da tela: "busy" enquanto responde, "shell" enquanto
// roda um comando no terminal (a própria tela dele mostra os dois como "working"), "waiting" quando pede
// permissão ou resposta, "idle" parado no prompt. Valor desconhecido fica sem indicador.
export function claudeActivity(status: unknown): AgentActivity | null {
  if (status === 'busy' || status === 'shell') return 'working'
  if (status === 'waiting' || status === 'idle') return 'waiting'
  return null
}

const TURN_EVENT = /"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted)"/g

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
