// Arrasto começado na página que o Chromium nunca leva adiante: depois do dragstart não chega nenhum evento de
// arrasto nem o fim dele, e a página descarta todo clique e tecla esperando. Visto no Windows ao arrastar um
// projeto da lateral: dragstart e, em seguida, silêncio total. Esse silêncio é o sinal para pedir ao main o
// cancelamento do arrasto.
export const NEVER_STARTED_MS = 3000
// Arrasto que andou e parou de receber eventos (o fim se perdeu com a máquina engasgada). Mais folga: quem segura o
// item parado sobre um lugar também passa um tempo sem mover o mouse.
export const WENT_SILENT_MS = 10_000
export const CHECK_EVERY_MS = 1000

export interface DragWatchdog {
  event(type: string): void
  // Devolve true quando pediu o destravamento.
  check(): boolean
}

const ACTIVITY = new Set(['drag', 'dragenter', 'dragover', 'dragleave'])

export function createDragWatchdog(release: () => void, now: () => number = Date.now): DragWatchdog {
  let dragging = false
  let active = false
  let last = 0
  let staleChecks = 0
  return {
    event(type) {
      if (type === 'dragstart') {
        dragging = true
        active = false
        last = now()
        staleChecks = 0
      } else if (type === 'dragend' || type === 'drop') {
        dragging = false
      } else if (dragging && ACTIVITY.has(type)) {
        active = true
        last = now()
        staleChecks = 0
      }
    },
    check() {
      if (!dragging) return false
      const stale = now() - last > (active ? WENT_SILENT_MS : NEVER_STARTED_MS)
      staleChecks = stale ? staleChecks + 1 : 0
      // Duas verificações seguidas: a interface presa numa tarefa longa roda o timer antes dos eventos que chegaram
      // nesse meio-tempo, e um arrasto saudável não pode ser cancelado por isso.
      if (staleChecks < 2) return false
      dragging = false
      staleChecks = 0
      release()
      return true
    }
  }
}

export function watchStuckDrags(release: () => void): void {
  const watchdog = createDragWatchdog(release)
  for (const type of ['dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
    window.addEventListener(type, (event) => watchdog.event(event.type), { capture: true, passive: true })
  }
  setInterval(() => watchdog.check(), CHECK_EVERY_MS)
}
