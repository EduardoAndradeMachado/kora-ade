const pt = (n: number, digits: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 })

export function formatTokens(n: number): string {
  if (n < 1000) return pt(n, 0)
  if (n < 1_000_000) return `${pt(n / 1000, n < 10_000 ? 1 : 0)} mil`
  return `${pt(n / 1_000_000, 2)} mi`
}

export function formatUsd(v: number): string {
  if (v === 0) return 'US$ 0'
  if (v < 0.01) return `US$ ${pt(v, 4)}`
  if (v < 10) return `US$ ${pt(v, 3)}`
  return `US$ ${pt(v, 2)}`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${pt(ms, 0)} ms`
  if (ms < 60_000) return `${pt(ms / 1000, 1)} s`
  const min = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  if (min < 60) return s ? `${min} min ${s} s` : `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

export const formatTps = (tps: number): string => `${pt(tps, tps < 10 ? 1 : 0)} tok/s`

export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5. Os demais ficam como o agente grava.
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(model)
  if (!m) return model
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const
export const OTHER_SERIES = 'var(--muted-foreground)'

// Cor fixa por modelo na ordem em que ele aparece: um modelo novo não repinta os anteriores. Num gráfico de
// pontos só três cores se distinguem com segurança; do quarto modelo em diante, todos ficam em "Outros".
export function colorByModel(modelsInOrder: string[]): Map<string, string> {
  const colors = new Map<string, string>()
  for (const model of modelsInOrder) {
    if (colors.has(model)) continue
    colors.set(model, SERIES[colors.size] ?? OTHER_SERIES)
  }
  return colors
}

// Faixa do gráfico do dia conforme o período coberto: até 3 h, 10 min; até 8 h, 20 min; acima disso, 30 min.
export function bucketSize(spanMs: number): number {
  const minutes = spanMs <= 3 * 3_600_000 ? 10 : spanMs <= 8 * 3_600_000 ? 20 : 30
  return minutes * 60_000
}

// Mediana por faixa de tempo a partir de `start`; faixa sem resposta fica null para a linha se interromper ali.
export function bucketMedians(points: { at: number; value: number }[], start: number, end: number, bucketMs: number): (number | null)[] {
  const count = Math.max(1, Math.ceil((end - start) / bucketMs))
  const buckets: number[][] = Array.from({ length: count }, () => [])
  for (const p of points) {
    const i = Math.floor((p.at - start) / bucketMs)
    if (i >= 0 && i < count) buckets[i]!.push(p.value)
  }
  return buckets.map((values) => median(values))
}
