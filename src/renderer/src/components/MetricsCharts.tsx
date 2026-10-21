import { useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const WIDTH = 264
const HEIGHT = 120
const PAD = { left: 30, right: 6, top: 6, bottom: 16 }
const PLOT_W = WIDTH - PAD.left - PAD.right
const PLOT_H = HEIGHT - PAD.top - PAD.bottom
const HOUR = 3_600_000

export interface LineSeries {
  id: string
  label: string
  color: string
  // Um valor por faixa de tempo; null = faixa sem resposta, onde a linha se interrompe.
  values: (number | null)[]
}

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value) ?? 10
  return step * magnitude
}

interface Props {
  series: LineSeries[]
  start: number
  bucketMs: number
  xLabel(at: number): string
  yLabel(y: number): string
  valueLabel(y: number): string
  ariaLabel: string
}

export function TimeLineChart({ series, start, bucketMs, xLabel, yLabel, valueLabel, ariaLabel }: Props): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const buckets = Math.max(1, ...series.map((s) => s.values.length))
  const end = start + buckets * bucketMs
  const yMax = useMemo(() => niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))) * 1.05), [series])
  const px = (at: number): number => PAD.left + ((at - start) / (end - start)) * PLOT_W
  const bx = (i: number): number => px(start + (i + 0.5) * bucketMs)
  const py = (y: number): number => PAD.top + PLOT_H - (y / yMax) * PLOT_H

  // Rótulos nas horas cheias, no máximo cinco.
  const hourStep = Math.max(1, Math.ceil((end - start) / HOUR / 4))
  const firstHour = Math.ceil(start / HOUR) * HOUR
  const hourTicks: number[] = []
  for (let at = firstHour; at <= end; at += hourStep * HOUR) hourTicks.push(at)

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = svgRef.current!.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * WIDTH
    const i = Math.floor(((mx - PAD.left) / PLOT_W) * buckets)
    setHover(i >= 0 && i < buckets ? i : null)
  }

  const shownRows = hover === null ? [] : series.map((s) => ({ s, v: s.values[hover] ?? null }))

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block h-auto w-full"
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {[0, yMax / 2, yMax].map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={py(t)} y2={py(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.left - 4} y={py(t) + 3} textAnchor="end" fontSize={8} fill="var(--muted-foreground)">
              {yLabel(t)}
            </text>
          </g>
        ))}
        {hourTicks.map((at) => (
          <text key={at} x={px(at)} y={HEIGHT - 3} textAnchor="middle" fontSize={8} fill="var(--muted-foreground)">
            {xLabel(at)}
          </text>
        ))}
        {hover !== null && (
          <line x1={bx(hover)} x2={bx(hover)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="2 2" />
        )}
        {series.map((s) => {
          // Cada trecho contínuo vira um caminho; faixa vazia interrompe. Faixa isolada vira um ponto.
          const runs: number[][] = []
          s.values.forEach((v, i) => {
            if (v === null) return
            const run = runs.at(-1)
            if (run && run.at(-1) === i - 1) run.push(i)
            else runs.push([i])
          })
          return (
            <g key={s.id}>
              {runs.map((run) =>
                run.length === 1 ? (
                  <circle key={run[0]} cx={bx(run[0]!)} cy={py(s.values[run[0]!]!)} r={2} fill={s.color} />
                ) : (
                  <path
                    key={run[0]}
                    d={run.map((i, k) => `${k === 0 ? 'M' : 'L'}${bx(i)},${py(s.values[i]!)}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )
              )}
              {hover !== null && s.values[hover] != null && (
                <circle cx={bx(hover)} cy={py(s.values[hover]!)} r={4} fill={s.color} stroke="var(--background)" strokeWidth={2} />
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div
          className={cn(
            'pointer-events-none absolute top-0 z-10 min-w-[140px] rounded-md border bg-card px-2 py-1 text-[11px] leading-snug text-foreground shadow-md',
            bx(hover) > WIDTH / 2 ? 'left-1' : 'right-1'
          )}
        >
          <div className="text-muted-foreground">
            {xLabel(start + hover * bucketMs)}–{xLabel(start + (hover + 1) * bucketMs)}
          </div>
          {shownRows.map(({ s, v }) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="flex-1 truncate">{s.label}</span>
              <span className="tabular-nums">{v === null ? '—' : valueLabel(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
