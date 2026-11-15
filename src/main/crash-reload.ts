// Interface que caiu (falta de memória, travou, processo morto pelo Gerenciador de Tarefas) volta sozinha. Uma que
// cai logo ao abrir ficaria recarregando sem parar, com a máquina sem memória: depois de algumas vezes no mesmo
// minuto, para e deixa a queda no log.
export const CRASH_RELOADS_PER_WINDOW = 3
export const CRASH_RELOAD_WINDOW_MS = 60_000

// 'clean-exit' é a janela fechando; 'abnormal-exit', 'launch-failed' e 'integrity-failure' voltariam a cair igual.
const RECOVERABLE = new Set(['crashed', 'oom', 'killed'])

export interface CrashReloadDecision {
  action: 'reload' | 'ignore' | 'give-up'
  // Os recarregamentos feitos dentro da janela de tempo, para a próxima decisão.
  recent: number[]
}

export function decideCrashReload(reason: string, recent: readonly number[], now: number): CrashReloadDecision {
  const inWindow = recent.filter((at) => now - at < CRASH_RELOAD_WINDOW_MS)
  if (!RECOVERABLE.has(reason)) return { action: 'ignore', recent: inWindow }
  if (inWindow.length >= CRASH_RELOADS_PER_WINDOW) return { action: 'give-up', recent: inWindow }
  return { action: 'reload', recent: [...inWindow, now] }
}

export function crashNotice(reason: string): string {
  const cause = reason === 'oom' ? ' por falta de memória' : ''
  return `A interface do Kora caiu${cause} e foi reaberta. Os terminais e os agentes continuaram rodando e foram reconectados; alterações não salvas nos arquivos abertos se perderam.`
}
