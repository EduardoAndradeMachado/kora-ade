import { useEffect, useRef } from 'react'
import { Button } from '@/brand/Button'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { useWindowDim } from '@/lib/use-window-dim'

export interface OrphanSurvivor {
  key: string
  title: string
  project: string
  agent: 'claude' | 'codex' | null
  memoryMb: number
  processCount: number
}

interface OrphanDialogProps {
  survivors: OrphanSurvivor[]
  onKillAll(): void
  onKeep(): void
  onKill(key: string): void
}

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

function formatMemory(mb: number): string {
  return mb >= 1024 ? `${number.format(mb / 1024)} GB` : `${Math.round(mb)} MB`
}

const processes = (n: number): string => (n === 1 ? '1 processo' : `${n} processos`)

export function OrphanDialog(props: OrphanDialogProps): React.JSX.Element | null {
  return props.survivors.length === 0 ? null : <Dialog {...props} />
}

function Dialog({ survivors, onKillAll, onKeep, onKill }: OrphanDialogProps): React.JSX.Element {
  const keepRef = useRef<HTMLButtonElement>(null)
  useWindowDim()

  // Esc e o foco inicial ficam em "Manter": nenhuma ação por teclado pode encerrar processos sem querer.
  useEffect(() => {
    keepRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onKeep()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKeep])

  const totalMb = survivors.reduce((sum, s) => sum + s.memoryMb, 0)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-[1px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="orphan-dialog-title"
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border bg-card p-4 shadow-2xl"
      >
        <h2 id="orphan-dialog-title" className="text-sm font-semibold">
          Processos de uma execução anterior ainda estão rodando
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          O Kora fechou sem encerrar estas abas, e elas somam {formatMemory(totalMb)} de memória. Nada é encerrado
          sem você pedir: se escolher Manter, os processos continuam rodando e o Kora deixa de acompanhá-los.
        </p>

        <ul className="mt-3 min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
          {survivors.map((s) => (
            <li key={s.key} className="flex items-center gap-2.5 px-3 py-2">
              {s.agent ? (
                <AgentIcon kind={s.agent} />
              ) : (
                <span aria-hidden className="size-4 shrink-0 rounded-sm border" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium" title={s.title}>
                  {s.title}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {s.project} · {s.agent ? `${agentLabel(s.agent)} · ` : ''}
                  {processes(s.processCount)} · {formatMemory(s.memoryMb)}
                </div>
              </div>
              <Button variant="secondary" className="shrink-0" onClick={() => onKill(s.key)}>
                Encerrar
              </Button>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button ref={keepRef} variant="secondary" onClick={onKeep}>
            Manter
          </Button>
          <Button variant="danger" onClick={onKillAll}>
            Encerrar todos
          </Button>
        </div>
      </div>
    </div>
  )
}
