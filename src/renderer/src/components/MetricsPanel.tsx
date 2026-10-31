import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isOff, type DayPoint, type ResponseMetric, type SessionMetrics } from '@shared/metrics'
import type { AgentActivity, AgentKind, AgentSession } from '@shared/agent'
import { Icon } from '@/brand/icons'
import { Loader } from '@/brand/Logo'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { TimeLineChart, type LineSeries } from '@/components/MetricsCharts'
import {
  bucketMedians,
  bucketSize,
  colorByModel,
  formatClock,
  formatTokens,
  formatTps,
  formatUsd,
  median,
  modelLabel,
  OTHER_SERIES
} from '@/lib/metrics-format'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'

interface Props {
  projectId: string
  agent: AgentSession | null
  activity: AgentActivity | null
}

type Scope = 'session' | 'day'

// Enquanto o agente trabalha, cada resposta entra no arquivo da conversa; a leitura é incremental e barata.
const WORKING_REFRESH_MS = 4000
const DAY_REFRESH_MS = 30_000
// Em resposta curta a espera pelo primeiro token domina o tempo e o TPS sai baixo demais.
const SHORT_RESPONSE = 50

const startOfToday = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function Off({ reason }: { reason: string }): React.JSX.Element {
  return (
    <span data-off data-tip={`Desativado\n${reason}`} className="cursor-help text-[10px] font-semibold tracking-wide text-muted-foreground/60">
      DESATIVADO
    </span>
  )
}

function Row({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <span className="shrink-0 text-muted-foreground" data-tip={tip}>
        {label}
      </span>
      <span className="min-w-0 truncate text-right tabular-nums text-foreground">{children}</span>
    </div>
  )
}

const COLLAPSED_KEY = 'kora.metricas.recolhidas'

function readCollapsed(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

// O estado vale para todas as abas: recolher "Custo" numa conversa recolhe em todas.
function useCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().has(id))
  const toggle = (): void => {
    const all = readCollapsed()
    if (collapsed) all.delete(id)
    else all.add(id)
    setCollapsed(!collapsed)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...all]))
    } catch {
      // Sem armazenamento a seção só não lembra o estado na próxima abertura.
    }
  }
  return [collapsed, toggle]
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }): React.JSX.Element {
  const [collapsed, toggle] = useCollapsed(id)
  return (
    <section className={cn('flex flex-col gap-1.5 border-b px-3 last:border-b-0', collapsed ? 'py-2' : 'py-3')}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <Icon name="expandir" className={cn('size-3 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
        {title}
      </button>
      {!collapsed && children}
    </section>
  )
}

function Legend({ colors, extra }: { colors: Map<string, string>; extra?: Map<string, string> }): React.JSX.Element | null {
  const entries = [...colors].filter(([, c]) => c !== OTHER_SERIES)
  const others = [...colors].filter(([, c]) => c === OTHER_SERIES).length
  if (entries.length + others < 2) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      {entries.map(([model, color]) => (
        <span key={model} className="flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: color }} />
          {extra?.get(model) ?? modelLabel(model)}
        </span>
      ))}
      {others > 0 && (
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: OTHER_SERIES }} />
          Outros ({others})
        </span>
      )}
    </div>
  )
}

const sum = (rs: ResponseMetric[], pick: (r: ResponseMetric) => number): number => rs.reduce((t, r) => t + pick(r), 0)

function modelStats(
  responses: { model: string; tps: number | null; outputTokens: number }[]
): { model: string; count: number; median: number | null }[] {
  const by = new Map<string, number[]>()
  const counts = new Map<string, number>()
  for (const r of responses) {
    counts.set(r.model, (counts.get(r.model) ?? 0) + 1)
    if (r.tps !== null && r.outputTokens >= SHORT_RESPONSE) by.set(r.model, [...(by.get(r.model) ?? []), r.tps])
  }
  return [...counts].map(([model, count]) => ({ model, count, median: median(by.get(model) ?? []) }))
}

function ModelTable({ stats, colors }: { stats: ReturnType<typeof modelStats>; colors: Map<string, string> }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-2 gap-y-0.5 text-xs">
      {stats.map((s) => (
        <div key={s.model} className="contents">
          <span className="flex min-w-0 items-center gap-1.5" data-tip={s.model}>
            <span className="size-2 shrink-0 rounded-full" style={{ background: colors.get(s.model) ?? OTHER_SERIES }} />
            <span className="truncate text-muted-foreground">{modelLabel(s.model)}</span>
          </span>
          <span className="text-right tabular-nums">{s.median !== null ? formatTps(s.median) : '—'}</span>
        </div>
      ))}
    </div>
  )
}

function SessionView({ m }: { m: SessionMetrics }): React.JSX.Element {
  const rs = m.responses
  const subs = m.subagentResponses
  const last = rs.at(-1)
  // O gráfico vai da faixa da primeira resposta até a última; conversa retomada dias depois só alarga a faixa.
  const chart = useMemo(() => {
    const all = [...rs, ...subs]
    const first = Math.min(...all.map((r) => r.at))
    const lastAt = Math.max(...all.map((r) => r.at))
    const bucketMs = bucketSize(lastAt - first)
    const start = first - (first % bucketMs)
    return { start, bucketMs, ...tpsLines(all, start, lastAt + 1, bucketMs) }
  }, [rs, subs])
  // Mesma cor para o mesmo modelo no gráfico, na conversa e nos subagentes.
  const colors = chart.colors
  const stats = useMemo(() => modelStats(rs), [rs])
  const subStats = useMemo(() => modelStats(subs), [subs])
  const tpsAll = rs.flatMap((r) => (r.tps !== null && r.outputTokens >= SHORT_RESPONSE ? [r.tps] : []))
  const tpsMedian = median(tpsAll)
  const lastTps = last?.tps ?? null

  const window = m.contextWindow
  const lastContext = last?.contextTokens ?? 0
  const costs = [...rs, ...subs].map((r) => r.costUsd)
  const costKnown = costs.some((c) => !isOff(c))
  // Modelo sem preço na tabela fica fora da soma; o aviso diz quais, para o total não parecer completo.
  const unpriced = [...new Set([...rs, ...subs].filter((r) => isOff(r.costUsd)).map((r) => modelLabel(r.model)))]
  const totalCost = sum([...rs, ...subs], (r) => (isOff(r.costUsd) ? 0 : r.costUsd))
  const costByModel = (list: ResponseMetric[]): [string, number][] => {
    const by = new Map<string, number>()
    for (const r of list) if (!isOff(r.costUsd)) by.set(r.model, (by.get(r.model) ?? 0) + r.costUsd)
    return [...by]
  }

  const input = sum(rs, (r) => r.inputTokens)
  const cacheRead = sum(rs, (r) => r.cacheReadTokens)
  const cacheWrite = sum(rs, (r) => r.cacheWriteTokens)
  const output = sum(rs, (r) => r.outputTokens)
  const prompt = input + cacheRead + cacheWrite


  if (rs.length === 0) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">Nenhuma resposta do modelo nesta conversa ainda. Os números aparecem ao fim da primeira resposta.</p>
  }

  return (
    <>
      <Section id="velocidade" title="Velocidade">
        <span
          className="self-start text-2xl font-semibold tabular-nums leading-none"
          data-tip={last ? `Última resposta · ${modelLabel(last.model)}` : undefined}
        >
          {lastTps !== null ? formatTps(lastTps) : '—'}
        </span>
        <Row label="Mediana da conversa">{tpsMedian !== null ? formatTps(tpsMedian) : '—'}</Row>
        <ModelTable stats={stats} colors={colors} />
        {subs.length > 0 && (
          <>
            <span className="mt-1 text-[11px] text-muted-foreground" data-tip="Mediana dos subagentes que esta conversa lançou">
              Subagentes
            </span>
            <ModelTable stats={subStats} colors={colors} />
          </>
        )}
      </Section>

      <Section id="grafico-sessao" title="TPS ao longo da conversa">
        <TpsChart
          series={chart.series}
          colors={colors}
          start={chart.start}
          bucketMs={chart.bucketMs}
          ariaLabel="Mediana de tokens por segundo ao longo da conversa, por modelo"
        />
        {chart.series.length === 0 && <p className="text-xs text-muted-foreground">Ainda sem respostas longas o bastante para o gráfico.</p>}
      </Section>

      <Section id="tokens" title="Tokens e contexto">
        <Row label="Entrada (sem cache)">{formatTokens(input)}</Row>
        <Row label="Cache lido">{formatTokens(cacheRead)}</Row>
        <Row label="Cache gravado">{formatTokens(cacheWrite)}</Row>
        <Row label="Saída" tip="Inclui o raciocínio">{formatTokens(output)}</Row>
        <Row
          label="Reaproveitado do cache"
          tip={`Quanto da entrada veio do cache
A cada resposta o agente reenvia a conversa inteira; a parte que já estava em cache sai bem mais barata e mais rápida. Quanto mais perto de 100%, melhor.`}
        >
          {prompt > 0 ? `${Math.round((cacheRead / prompt) * 100)}%` : '—'}
        </Row>
        <Row label="Contexto atual">
          {formatTokens(lastContext)}
          {!isOff(window) && <span className="text-muted-foreground"> de {formatTokens(window)}</span>}
        </Row>
        {isOff(window) ? (
          <Row label="Janela de contexto">
            <Off reason={window.off} />
          </Row>
        ) : (
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.round((lastContext / window) * 100)}>
            <div className="h-full rounded-full bg-[var(--series-1)]" style={{ width: `${Math.min(100, (lastContext / window) * 100)}%` }} />
          </div>
        )}
      </Section>

      <Section id="custo" title={m.costKind === 'real' ? 'Custo (real)' : 'Custo (se fosse pela API)'}>
        {costKnown ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-semibold tabular-nums">{formatUsd(totalCost)}</span>
              <span className="text-[11px] text-muted-foreground" data-tip={m.costKind === 'real' ? 'Valor gravado pelo OpenCode' : 'Preço público da API por token; a assinatura não cobra assim'}>
                {m.costKind === 'real' ? 'gravado pelo OpenCode' : 'estimado'}
              </span>
            </div>
            {costByModel(rs).map(([model, usd]) => (
              <Row key={model} label={modelLabel(model)}>
                {formatUsd(usd)}
              </Row>
            ))}
            {subs.length > 0 && (
              <>
                <span className="mt-1 text-[11px] text-muted-foreground">Subagentes</span>
                {costByModel(subs).map(([model, usd]) => (
                  <Row key={model} label={modelLabel(model)}>
                    {formatUsd(usd)}
                  </Row>
                ))}
              </>
            )}
            {unpriced.length > 0 && (
              <p className="text-[10px] text-muted-foreground">Sem preço na tabela, fora da soma: {unpriced.join(', ')}.</p>
            )}
          </>
        ) : (
          <Row label="Custo">{isOff(costs[0]) ? <Off reason={costs[0].off} /> : '—'}</Row>
        )}
      </Section>

      <Section id="atividade" title="Atividade">
        <Row label="Turnos">{m.turns}</Row>
        <Row label="Respostas do modelo">{rs.length}</Row>
        <Row label="Interrupções">{m.interruptions}</Row>
        <Row label="Subagentes">{m.subagents}</Row>
        <Row label="Compactações">{m.compactions}</Row>
      </Section>
    </>
  )
}

const AGENT_ORDER: AgentKind[] = ['claude', 'codex', 'opencode']

// Mais que três linhas embola o gráfico e passa do limite de cores que se distinguem com segurança.
// Mais que três linhas embola o gráfico e passa do limite de cores que se distinguem com segurança.
const CHART_LINES = 3

interface Plotted {
  at: number
  model: string
  tps: number | null
  outputTokens: number
}

// Uma linha por modelo, para os três com mais respostas; a cor segue a ordem em que cada um apareceu e os demais
// ficam cinza nas listas. Respostas curtas ficam fora: nelas a espera pelo 1º token derruba o número.
function tpsLines(points: Plotted[], start: number, end: number, bucketMs: number): { series: LineSeries[]; colors: Map<string, string> } {
  const solid = points.filter((p): p is Plotted & { tps: number } => p.tps !== null && p.outputTokens >= SHORT_RESPONSE)
  const counts = new Map<string, number>()
  for (const p of solid) counts.set(p.model, (counts.get(p.model) ?? 0) + 1)
  const top = new Set([...counts].sort((x, y) => y[1] - x[1]).slice(0, CHART_LINES).map(([model]) => model))
  const charted = [...new Set([...solid].sort((x, y) => x.at - y.at).map((p) => p.model))].filter((model) => top.has(model))
  const colors = colorByModel(charted)
  const series = charted.map((model) => ({
    id: model,
    label: modelLabel(model),
    color: colors.get(model) ?? OTHER_SERIES,
    values: bucketMedians(
      solid.filter((p) => p.model === model).map((p) => ({ at: p.at, value: p.tps })),
      start,
      end,
      bucketMs
    )
  }))
  return { series, colors }
}

function TpsChart(props: {
  series: LineSeries[]
  colors: Map<string, string>
  start: number
  bucketMs: number
  ariaLabel: string
}): React.JSX.Element | null {
  if (props.series.length === 0) return null
  return (
    <>
      <TimeLineChart
        series={props.series}
        start={props.start}
        bucketMs={props.bucketMs}
        xLabel={formatClock}
        yLabel={(y) => `${Math.round(y)}`}
        valueLabel={formatTps}
        ariaLabel={props.ariaLabel}
      />
      <Legend colors={props.colors} />
    </>
  )
}

function DayView({ points }: { points: DayPoint[] }): React.JSX.Element {
  const solid = useMemo(() => points.filter((p) => p.outputTokens >= SHORT_RESPONSE), [points])
  const groups = useMemo(
    () =>
      AGENT_ORDER.flatMap((agent) => {
        const own = points.filter((p) => p.agent === agent)
        if (own.length === 0) return []
        const tps = own.filter((p) => p.outputTokens >= SHORT_RESPONSE).map((p) => p.tps)
        return [{ agent, median: median(tps), stats: modelStats(own) }]
      }),
    [points]
  )
  const now = Date.now()
  // O eixo começa na hora cheia da primeira resposta: a madrugada vazia só achataria o gráfico.
  const first = points[0]?.at ?? startOfToday()
  const start = first - (first % 3_600_000)
  const bucketMs = bucketSize(now - start)
  const { series, colors } = useMemo(() => tpsLines(points, start, now, bucketMs), [points, start, now, bucketMs])
  const hourAgo = now - 3_600_000
  const lastHour = median(solid.filter((p) => p.at >= hourAgo).map((p) => p.tps))
  const day = median(solid.map((p) => p.tps))
  if (points.length === 0) return <p className="px-3 py-3 text-xs text-muted-foreground">Nenhuma resposta hoje ainda.</p>
  return (
    <Section id="hoje" title="TPS de hoje (todas as conversas)">
      <TpsChart series={series} colors={colors} start={start} bucketMs={bucketMs} ariaLabel="Mediana de tokens por segundo ao longo do dia, por modelo" />
      <div className="flex flex-col">
        <Row label="Mediana do dia">{day !== null ? formatTps(day) : '—'}</Row>
        <Row label="Mediana da última hora">{lastHour !== null ? formatTps(lastHour) : '—'}</Row>
      </div>
      {groups.map((g) => (
        <div key={g.agent} className="mt-1.5 flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 border-b pb-0.5 text-xs font-medium">
            <AgentIcon kind={g.agent} className="size-3.5" />
            <span className="flex-1">{agentLabel(g.agent)}</span>
            <span className="tabular-nums" data-tip="Mediana do agente">
              {g.median !== null ? formatTps(g.median) : '—'}
            </span>
          </div>
          <ModelTable stats={g.stats} colors={colors} />
        </div>
      ))}
    </Section>
  )
}

// O Claude deriva o nome da sessão como <pasta>-<sufixo curto> e é o sufixo que separa duas sessões da mesma pasta;
// com o painel estreito, cortar pelo fim escondia justamente ele. Nome livre (título, /rename) corta pelo fim.
const DERIVED_SUFFIX = /^(.+)(-[0-9a-z]{1,4})$/i

function AgentName({ name }: { name: string }): React.JSX.Element {
  const parts = DERIVED_SUFFIX.exec(name)
  if (!parts) return <span className="truncate">{name}</span>
  return (
    <span className="flex min-w-0">
      <span className="truncate">{parts[1]}</span>
      <span className="shrink-0">{parts[2]}</span>
    </span>
  )
}

function CopyableName({ name, className }: { name: string; className?: string }): React.JSX.Element {
  const [copied, setCopied] = useState<'ok' | 'falhou' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = (result: 'ok' | 'falhou'): void => {
    setCopied(result)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1500)
  }
  const copy = (): void => {
    navigator.clipboard.writeText(name).then(
      () => show('ok'),
      () => show('falhou')
    )
  }
  return (
    <button
      type="button"
      onClick={copy}
      data-tip={copied === 'ok' ? 'Copiado' : copied === 'falhou' ? 'Não foi possível copiar' : `Copiar ${name}`}
      className={cn('group flex min-w-0 items-center gap-1 rounded px-1 text-left hover:bg-secondary', className)}
    >
      <AgentName name={name} />
      <Icon
        name={copied === 'ok' ? 'ok' : 'copiar'}
        className={cn(
          'size-3 shrink-0',
          copied === 'ok' ? 'text-[var(--brand-amber)]' : copied === 'falhou' ? 'text-destructive' : 'opacity-0 group-hover:opacity-100'
        )}
      />
    </button>
  )
}

export function MetricsPanel({ projectId, agent, activity }: Props): React.JSX.Element {
  const [scope, setScope] = useState<Scope>('session')
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null)
  const [day, setDay] = useState<DayPoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const kind = agent?.kind
  const sessionId = agent?.sessionId

  const loadSession = useCallback(() => {
    if (!kind || !sessionId) return
    window.kora.sessionMetrics(projectId, { kind, sessionId }).then(
      (m) => {
        // Resposta atrasada da sessão anterior (troca de aba no meio da leitura) não sobrescreve a atual.
        if (m.sessionId !== sessionId) return
        setMetrics(m)
        setError(null)
      },
      (err: unknown) => setError(ipcErrorMessage(err))
    )
  }, [projectId, kind, sessionId])

  useEffect(() => {
    setMetrics(null)
  }, [kind, sessionId])

  useEffect(() => {
    if (scope !== 'session') return
    loadSession()
    if (activity !== 'working') return
    const id = window.setInterval(loadSession, WORKING_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [scope, loadSession, activity])

  useEffect(() => {
    if (scope !== 'day') return
    const load = (): void => {
      window.kora.dayMetrics(startOfToday()).then(
        (points) => {
          setDay(points)
          setError(null)
        },
        (err: unknown) => setError(ipcErrorMessage(err))
      )
    }
    load()
    const id = window.setInterval(load, DAY_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [scope])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        {agent ? (
          <span className="flex min-w-0 flex-1 items-center gap-0.5 text-xs">
            <span className="flex shrink-0" data-tip={`${agentLabel(agent.kind)} · ${agent.sessionId}`}>
              <AgentIcon kind={agent.kind} className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-col">
              {agent.name ? (
                <CopyableName key={agent.name} name={agent.name} />
              ) : (
                <span className="truncate px-1">{agentLabel(agent.kind)}</span>
              )}
              {agent.derivedName && (
                <CopyableName key={agent.derivedName} name={agent.derivedName} className="text-[11px] text-muted-foreground" />
              )}
            </span>
          </span>
        ) : (
          <span className="flex-1 text-xs text-muted-foreground">Sem sessão de agente</span>
        )}
        <div className="flex shrink-0 rounded-md bg-secondary p-0.5 text-[11px]">
          {(['session', 'day'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn('rounded px-2 py-0.5', scope === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {s === 'session' ? 'Esta sessão' : 'Hoje'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden border-t">
        {scope === 'session' ? (
          !agent ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              Selecione uma aba do Claude, do Codex ou do OpenCode. A aba do Codex só ganha sessão depois da primeira mensagem.
            </p>
          ) : metrics ? (
            <SessionView m={metrics} />
          ) : (
            <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <Loader size={18} />
              Lendo a conversa…
            </div>
          )
        ) : day ? (
          <DayView points={day} />
        ) : (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader size={18} />
            Lendo as conversas de hoje…
          </div>
        )}
      </div>
    </div>
  )
}
