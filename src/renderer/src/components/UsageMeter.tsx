import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentUsage, UsageWindow } from '@shared/usage-types'
import { formatRemaining, formatResetAt, isCritical, mostConstrained } from '@shared/usage-format'
import { Icon } from '@/brand/icons'
import { cn } from '@/lib/utils'
import { AgentIcon, agentLabel } from './AgentIcon'

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

function Bar({ percent, className }: { percent: number; className?: string }): React.JSX.Element {
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
  w.resetsAt === null ? 'sem reset pendente' : `reseta em ${formatRemaining(w.resetsAt - now)}`

function CompactAgent({ usage, now }: { usage: AgentUsage; now: number }): React.JSX.Element {
  const tight = mostConstrained(usage.windows)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <AgentIcon kind={usage.agent} className="size-3" />
      {tight ? (
        <>
          <Bar percent={tight.usedPercent} className="h-1 w-8 shrink-0" />
          <span className={cn('tabular-nums', isCritical(tight.usedPercent) && 'text-destructive')}>
            {Math.round(tight.usedPercent)}%
          </span>
          <span className="truncate">· {resetIn(tight, now)}</span>
        </>
      ) : (
        <span className="flex items-center gap-1">
          <Icon name="alerta" className="size-3" />
          indisponível
        </span>
      )}
      {tight && usage.error && <Icon name="alerta" className="size-3 text-destructive" />}
    </span>
  )
}

function AgentDetail({ usage, now }: { usage: AgentUsage; now: number }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <AgentIcon kind={usage.agent} className="size-3.5" />
        <span className="text-xs font-medium">{agentLabel(usage.agent)}</span>
        <span className="ml-auto truncate text-[11px] text-muted-foreground" title={usage.source}>
          {usage.source}
        </span>
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
              : `Reseta em ${formatRemaining(w.resetsAt - now)} · ${formatResetAt(w.resetsAt, now)}`}
          </span>
        </div>
      ))}
      <span className="text-[11px] text-muted-foreground">Dado de {formatResetAt(usage.updatedAt, now)}</span>
    </section>
  )
}

export function UsageMeter({ usage, onRefresh }: Props): React.JSX.Element {
  const now = useNow()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)

  const toggle = (): void => {
    if (anchor) return setAnchor(null)
    const r = triggerRef.current!.getBoundingClientRect()
    // Abre para cima (o medidor fica no rodapé) e não passa da borda direita em janelas estreitas.
    setAnchor({
      left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8)),
      bottom: window.innerHeight - r.top + GAP
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
        title="Limites de uso — clique para detalhes"
        aria-expanded={anchor !== null}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        {usage.length === 0 ? (
          <span>Uso dos agentes indisponível</span>
        ) : (
          usage.map((u) => <CompactAgent key={u.agent} usage={u} now={now} />)
        )}
      </button>
      {anchor &&
        createPortal(
          <div
            role="dialog"
            aria-label="Limites de uso"
            onMouseDown={(e) => e.stopPropagation()}
            style={{ left: anchor.left, bottom: anchor.bottom, width: POPOVER_WIDTH }}
            className="fixed z-50 flex max-h-[70vh] max-w-[calc(100vw-16px)] flex-col gap-3 overflow-y-auto rounded-lg border bg-card p-3 text-card-foreground shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Limites de uso</span>
              <button
                type="button"
                title="Atualizar"
                aria-label="Atualizar"
                onClick={onRefresh}
                className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Icon name="atualizar" className="size-3.5" />
              </button>
            </div>
            {usage.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum dado de uso do Claude Code nem do Codex nesta máquina.</p>
            ) : (
              usage.map((u, i) => (
                <div key={u.agent} className={cn(i > 0 && 'border-t pt-3')}>
                  <AgentDetail usage={u} now={now} />
                </div>
              ))
            )}
          </div>,
          document.body
        )}
    </>
  )
}
