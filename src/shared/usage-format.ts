import type { UsageWindow } from './usage-types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const CRITICAL_PERCENT = 80

export const isCritical = (usedPercent: number): boolean => usedPercent > CRITICAL_PERCENT

export function windowLabel(minutes: number | null): string {
  if (minutes === null) return 'Janela'
  if (minutes === 10080) return 'Semanal'
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Diária' : `${minutes / 1440} dias`
  if (minutes % 60 === 0) return `${minutes / 60} h`
  return `${minutes} min`
}

/** "3h 8m", "6d 11h", "12m"; sempre as duas maiores unidades, como a barra do Orca. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'agora'
  if (ms < MINUTE) return '<1m'
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

export function formatResetAt(resetsAt: number, now: number, timeZone?: string): string {
  const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone }).format(resetsAt)
  const day = (t: number): string => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone }).format(t)
  if (day(resetsAt) === day(now)) return `hoje às ${time}`
  if (day(resetsAt) === day(now + DAY)) return `amanhã às ${time}`
  const date = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone }).format(
    resetsAt
  )
  return `${date} às ${time}`
}

/** A janela que vai estourar primeiro: maior uso, e no empate a que reseta mais tarde (prende por mais tempo). */
export function mostConstrained(windows: UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const w of windows) {
    if (
      best === null ||
      w.usedPercent > best.usedPercent ||
      (w.usedPercent === best.usedPercent && (w.resetsAt ?? 0) > (best.resetsAt ?? 0))
    ) {
      best = w
    }
  }
  return best
}
