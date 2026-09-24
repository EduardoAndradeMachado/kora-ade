import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

type Step = 1 | -1 | 0

interface Props {
  zoom: number
  terminalFontSize: number
  onZoom(step: Step): void
  onTerminalFont(step: Step): void
}

const stepButton =
  'flex size-6 items-center justify-center rounded-md border text-sm leading-none text-foreground hover:bg-secondary'

function Row(props: { label: string; value: string; shortcut: string; onStep(step: Step): void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium text-foreground">{props.label}</span>
        <span className="text-[11px] text-muted-foreground">{props.shortcut}</span>
      </div>
      <button type="button" title={`Diminuir ${props.label.toLowerCase()}`} onClick={() => props.onStep(-1)} className={stepButton}>
        −
      </button>
      <button
        type="button"
        title="Voltar ao padrão"
        onClick={() => props.onStep(0)}
        className="w-12 rounded-md py-0.5 text-center text-xs tabular-nums text-foreground hover:bg-secondary"
      >
        {props.value}
      </button>
      <button type="button" title={`Aumentar ${props.label.toLowerCase()}`} onClick={() => props.onStep(1)} className={stepButton}>
        +
      </button>
    </div>
  )
}

// Os dois tamanhos são independentes; o painel mostra os atalhos para quem quiser parar de abrir o painel.
export function SizeControl(props: Props): React.JSX.Element {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!anchor) return
    const close = (e: MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node)) setAnchor(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAnchor(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor])

  return (
    <>
      <button
        type="button"
        title="Tamanho da interface e do texto do terminal"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs tabular-nums text-muted-foreground hover:bg-secondary hover:text-foreground',
          anchor && 'bg-secondary text-foreground'
        )}
      >
        <span className="text-[13px] leading-none">Aa</span>
        {Math.round(props.zoom * 100)}% · {props.terminalFontSize} px
      </button>
      {anchor &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Tamanhos"
            style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 6 }}
            className="fixed z-50 flex w-64 flex-col gap-3 rounded-lg border bg-card p-3 shadow-xl"
          >
            <Row
              label="Interface"
              value={`${Math.round(props.zoom * 100)}%`}
              shortcut="Ctrl + / Ctrl − / Ctrl 0"
              onStep={props.onZoom}
            />
            <Row
              label="Texto do terminal"
              value={`${props.terminalFontSize} px`}
              shortcut="Ctrl Shift + / − / 0 ou Ctrl + roda"
              onStep={props.onTerminalFont}
            />
          </div>,
          document.body
        )}
    </>
  )
}
