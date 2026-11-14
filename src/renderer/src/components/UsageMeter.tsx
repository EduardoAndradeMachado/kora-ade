import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentUsage, UsageWindow } from '@shared/usage-types'
import type { WeeklyUsage } from '@shared/claude-accounts'
import { formatResetAt, formatResetIn, isCritical, mostConstrained } from '@shared/usage-format'
import { Icon } from '@/brand/icons'
import { cn } from '@/lib/utils'
import { AgentIcon, agentLabel } from './AgentIcon'
import { ClaudeAccountSwitcher } from './ClaudeAccounts'

interface Props {
  usage: AgentUsage[]
  onRefresh(): void
}

const POPOVER_WIDTH = 320
const GAP = 6

// Só o relógio anda aqui; os dados chegam por props. 30 s basta para "reseta em" com precisão de minuto.
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

export function Bar({ percent, className }: { percent: number; className?: string }): React.JSX.Element {
  const value = Math.round(percent)
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={cn('overflow-hidden rounded-full bg-secondary', className)}
    >
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, percent))}%`,
          background: isCritical(percent) ? 'var(--destructive)' : 'var(--brand-amber)'
        }}
      />
    </div>
  )
}

const resetIn = (w: UsageWindow, now: number): string =>
  w.resetsAt === null ? 'sem reset pendente' : `reseta ${formatResetIn(w.resetsAt - now)}`

const HOVER_DELAY_MS = 350
// Tempo para o mouse atravessar o vão entre duas células sem o cartão sumir e voltar a esperar.
const HOVER_GRACE_MS = 80
const MARGIN = 8

// Uma célula por agente com a janela mais apertada; o "reseta em" só cabe quando há um agente sozinho na linha.
// Erro com janelas antigas vira um ponto sobre o ícone: um alerta a mais por célula estoura os três na lateral.
function CompactAgent({ usage, now, alone }: { usage: AgentUsage; now: number; alone: boolean }): React.JSX.Element {
  const tight = mostConstrained(usage.windows)
  return (
    <>
      <span className="relative flex shrink-0">
        <AgentIcon kind={usage.agent} className="size-3" />
        {tight && usage.error && (
          <span data-usage-error className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive ring-1 ring-background" />
        )}
      </span>
      {tight ? (
        <>
          <Bar percent={tight.usedPercent} className={cn('h-1 bg-foreground/10', alone ? 'w-8 shrink-0' : 'w-6 min-w-2 shrink')} />
          <span className={cn('shrink-0 tabular-nums', isCritical(tight.usedPercent) && 'text-destructive')}>
            {Math.round(tight.usedPercent)}%
          </span>
          {alone && <span className="truncate">· {resetIn(tight, now)}</span>}
        </>
      ) : (
        <span className="flex min-w-0 items-center gap-1">
          <Icon name="alerta" className="size-3 shrink-0" />
          <span className="truncate">indisponível</span>
        </span>
      )}
    </>
  )
}

// Cartão do hover: o rodapé só tem espaço para o ícone e a barra; aqui cabem o nome e todas as janelas sem quebrar linha.
function UsageCard({ usage, now, anchor }: { usage: AgentUsage; now: number; anchor: DOMRect }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const tight = mostConstrained(usage.windows)

  // Em cima da célula (o medidor fica no rodapé), centralizado e sem sair da janela pelos lados.
  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect()
    const center = anchor.left + anchor.width / 2
    const left = Math.min(Math.max(center - box.width / 2, MARGIN), window.innerWidth - box.width - MARGIN)
    const above = anchor.top - GAP - box.height >= MARGIN
    setPlace({ left, top: above ? anchor.top - GAP - box.height : anchor.bottom + GAP })
  }, [anchor, usage])

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-usage-card={usage.agent}
      style={place ?? { left: -9999, top: 0 }}
      className="pointer-events-none fixed z-[70] w-max max-w-[min(20rem,calc(100vw-16px))] rounded-lg border bg-card px-3 py-2.5 text-xs text-card-foreground shadow-xl"
    >
      <div className="flex items-center gap-2 whitespace-nowrap">
        <AgentIcon kind={usage.agent} className="size-3.5 shrink-0" />
        <span className="font-medium">{agentLabel(usage.agent)}</span>
        {(usage.account ?? usage.plan) && (
          <span className="ml-auto truncate pl-4 text-[11px] text-muted-foreground">{usage.account ?? usage.plan}</span>
        )}
      </div>
      {usage.windows.length > 0 && (
        <div className="mt-2 grid grid-cols-[auto_auto_auto_auto] items-center gap-x-2.5 gap-y-1.5 whitespace-nowrap">
          {usage.windows.map((w) => (
            <Fragment key={w.label}>
              <span className={w === tight ? 'text-foreground' : 'text-muted-foreground'}>{w.label}</span>
              <Bar percent={w.usedPercent} className="h-1 w-14 bg-foreground/10" />
              <span className={cn('text-right font-medium tabular-nums', isCritical(w.usedPercent) && 'text-destructive')}>
                {Math.round(w.usedPercent)}%
              </span>
              <span className="text-[11px] text-muted-foreground">{resetIn(w, now)}</span>
            </Fragment>
          ))}
        </div>
      )}
      {(usage.error || usage.windows.length === 0) && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
          <Icon name="alerta" className="mt-px size-3 shrink-0" />
          <span>{usage.error ?? 'Uso indisponível'}</span>
        </p>
      )}
      <p className="mt-2 border-t pt-1.5 text-[10px] text-muted-foreground">Clique para ver os detalhes</p>
    </div>,
    document.body
  )
}

export function CompactUsage({ usage, now }: { usage: AgentUsage[]; now: number }): React.JSX.Element {
  const [hovered, setHovered] = useState<{ agent: AgentUsage['agent']; anchor: DOMRect } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (!hovered) return
    const hide = (): void => setHovered(null)
    window.addEventListener('blur', hide)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('blur', hide)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [hovered])

  // Só mouse: no celular o toque já abre os detalhes, e o cartão ficaria preso na tela.
  const enter = (agent: AgentUsage['agent']) => (e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.pointerType !== 'mouse') return
    window.clearTimeout(timer.current)
    const anchor = e.currentTarget.getBoundingClientRect()
    const show = (): void => setHovered({ agent, anchor })
    if (hovered) show()
    else timer.current = window.setTimeout(show, HOVER_DELAY_MS)
  }
  const leave = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHovered(null), HOVER_GRACE_MS)
  }
  const dismiss = (): void => {
    window.clearTimeout(timer.current)
    setHovered(null)
  }

  const card = hovered && usage.find((u) => u.agent === hovered.agent)
  return (
    <span
      className="grid w-full min-w-0 items-center gap-x-2"
      style={{
        gridTemplateColumns: `repeat(${usage.length}, minmax(0, auto))`,
        justifyContent: usage.length === 1 ? 'start' : 'space-between'
      }}
    >
      {usage.map((u) => (
        <span
          key={u.agent}
          data-usage-cell={u.agent}
          onPointerEnter={enter(u.agent)}
          onPointerLeave={leave}
          onPointerDown={dismiss}
          className="flex min-w-0 items-center gap-1"
        >
          <CompactAgent usage={u} now={now} alone={usage.length === 1} />
        </span>
      ))}
      {card && <UsageCard usage={card} now={now} anchor={hovered.anchor} />}
    </span>
  )
}

export function claudeWeekly(claude: AgentUsage): WeeklyUsage | null {
  const weekly = claude.windows.find((w) => w.label === 'Semanal' && w.windowMinutes === 10080)
  return weekly ? { usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt, recordedAt: claude.updatedAt } : null
}

function AgentDetail({ usage, now, onRefresh }: { usage: AgentUsage; now: number; onRefresh(): void }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <AgentIcon kind={usage.agent} className="size-3.5" />
        <span className="text-xs font-medium">{agentLabel(usage.agent)}</span>
        {usage.agent === 'claude' ? (
          <ClaudeAccountSwitcher now={now} liveWeekly={claudeWeekly(usage)} onSwitched={onRefresh} />
        ) : (
          (usage.account ?? usage.plan) && (
            <span className="ml-auto truncate px-1.5 text-[11px] text-muted-foreground">{usage.account ?? usage.plan}</span>
          )
        )}
      </header>
      {usage.error && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <Icon name="alerta" className="mt-px size-3" />
          <span>{usage.error}</span>
        </p>
      )}
      {usage.windows.map((w) => (
        <div key={w.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate">{w.label}</span>
            <span className={cn('shrink-0 tabular-nums', isCritical(w.usedPercent) && 'text-destructive')}>
              {Math.round(w.usedPercent)}% usado
            </span>
          </div>
          <Bar percent={w.usedPercent} className="h-1.5 w-full" />
          <span className="text-[11px] text-muted-foreground">
            {w.resetsAt === null
              ? 'Sem reset pendente'
              : `Reseta ${formatResetIn(w.resetsAt - now)} · ${formatResetAt(w.resetsAt, now)}`}
          </span>
        </div>
      ))}
      <span className="text-[11px] text-muted-foreground">
        Dado de {formatResetAt(usage.updatedAt, now)}
        {usage.nextCheckAt !== undefined && usage.nextCheckAt > now && (
          <span data-next-check> · próxima consulta {formatResetAt(usage.nextCheckAt, now)}</span>
        )}
      </span>
    </section>
  )
}

export function UsageMeter({ usage, onRefresh }: Props): React.JSX.Element {
  const now = useNow()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null)

  const toggle = (): void => {
    if (anchor) return setAnchor(null)
    const r = triggerRef.current!.getBoundingClientRect()
    // Abre para cima (o medidor fica no rodapé) e não passa da borda direita em janelas estreitas.
    setAnchor({
      left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8)),
      bottom: window.innerHeight - r.top + GAP,
      // Usa toda a altura acima do rodapé; só rola quando os agentes não cabem na janela.
      maxHeight: Math.max(160, r.top - GAP - 8)
    })
  }

  useEffect(() => {
    if (!anchor) return
    const close = (): void => setAnchor(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-tip={usage.length === 0 ? 'Limites de uso — clique para detalhes' : undefined}
        aria-expanded={anchor !== null}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        {usage.length === 0 ? (
          <span>Uso dos agentes indisponível</span>
        ) : (
          <CompactUsage usage={usage} now={now} />
        )}
      </button>
      {anchor &&
        createPortal(
          <div
            role="dialog"
            aria-label="Limites de uso"
            onMouseDown={(e) => e.stopPropagation()}
            style={{ left: anchor.left, bottom: anchor.bottom, width: POPOVER_WIDTH, maxHeight: anchor.maxHeight }}
            className="fixed z-50 flex max-w-[calc(100vw-16px)] flex-col gap-3 overflow-y-auto rounded-lg border bg-card p-3 text-card-foreground shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Limites de uso</span>
              <button
                type="button"
                data-tip="Atualizar"
                aria-label="Atualizar"
                onClick={onRefresh}
                className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Icon name="atualizar" className="size-3.5" />
              </button>
            </div>
            {usage.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum dado de uso do Claude Code, do Codex nem do OpenCode Go nesta máquina.</p>
            ) : (
              usage.map((u, i) => (
                <div key={u.agent} className={cn(i > 0 && 'border-t pt-3')}>
                  <AgentDetail usage={u} now={now} onRefresh={onRefresh} />
                </div>
              ))
            )}
          </div>,
          document.body
        )}
    </>
  )
}
