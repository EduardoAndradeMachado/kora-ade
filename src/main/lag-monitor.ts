// Mede o atraso do laço de eventos: um timer que deveria disparar a cada `intervalMs` e chega bem depois indica
// que algo síncrono segurou o processo. A linha registrada leva as últimas operações, que apontam o culpado.
export interface LagMonitorOptions {
  intervalMs: number
  thresholdMs: number
  write(line: string): void
  now?: () => number
}

const RECENT = 8

export function createLagMonitor(options: LagMonitorOptions): { note(label: string): void; stop(): void } {
  const now = options.now ?? Date.now
  const recent: string[] = []
  let last = now()
  const timer = setInterval(() => {
    const t = now()
    const lag = t - last - options.intervalMs
    last = t
    if (lag > options.thresholdMs) {
      options.write(`${new Date(t).toISOString()} main travado ${Math.round(lag)} ms; últimas operações: ${recent.join(', ') || 'nenhuma'}`)
    }
  }, options.intervalMs)
  timer.unref?.()
  return {
    note(label) {
      recent.push(label)
      if (recent.length > RECENT) recent.shift()
    },
    stop: () => clearInterval(timer)
  }
}
