import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/brand/icons'
import { AgentIcon } from '@/components/AgentIcon'
import { cn } from '@/lib/utils'

export type NewTabChoice = 'shell' | 'claude' | 'codex' | 'opencode' | 'existing'

export const OPTIONS: { choice: NewTabChoice; label: string; hint: string }[] = [
  { choice: 'claude', label: 'Claude', hint: 'sessão nova, já vinculada à aba' },
  { choice: 'codex', label: 'Codex', hint: 'sessão nova, vínculo detectado' },
  { choice: 'opencode', label: 'OpenCode', hint: 'sessão nova, já vinculada à aba' },
  { choice: 'shell', label: 'Terminal', hint: 'PowerShell na pasta do projeto' },
  { choice: 'existing', label: 'Sessão existente', hint: 'fixar uma sessão pelo ID' }
]

interface Props {
  onChoose(choice: NewTabChoice): void
  className?: string
  iconClassName?: string
}

const WIDTH = 240
const GAP = 4
const MARGIN = 8

export function NewTabMenu({ onChoose, className, iconClassName }: Props): React.JSX.Element {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Abre embaixo do botão; sem espaço embaixo (projeto no fim da lista lateral) abre para cima.
  useLayoutEffect(() => {
    if (!anchor) return setPos(null)
    const height = menuRef.current!.getBoundingClientRect().height
    const below = anchor.bottom + GAP + height <= window.innerHeight - MARGIN
    setPos({
      x: Math.min(anchor.left, window.innerWidth - WIDTH - MARGIN),
      y: below ? anchor.bottom + GAP : Math.max(MARGIN, anchor.top - GAP - height)
    })
  }, [anchor])

  useEffect(() => {
    if (!anchor) return
    const close = (): void => setAnchor(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [anchor])

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setAnchor(anchor ? null : buttonRef.current!.getBoundingClientRect())
  }

  return (
    <>
      <button ref={buttonRef} type="button" data-tip="Nova aba" aria-label="Nova aba" onClick={toggle} className={className}>
        <Icon name="novaAba" className={iconClassName ?? 'size-4'} />
      </button>
      {anchor &&
        createPortal(
        <div
          ref={menuRef}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, width: WIDTH, visibility: pos ? 'visible' : 'hidden' }}
          className="fixed z-50 rounded-lg border bg-card p-1 shadow-xl"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.choice}
              type="button"
              onClick={() => {
                setAnchor(null)
                onChoose(o.choice)
              }}
              className={cn('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-secondary')}
            >
              {o.choice === 'shell' ? (
                <Icon name="terminal" className="text-muted-foreground" />
              ) : o.choice === 'existing' ? (
                <Icon name="fixar" className="text-muted-foreground" />
              ) : (
                <AgentIcon kind={o.choice} className="size-4" />
              )}
              <span className="flex flex-col">
                <span className="text-xs font-medium">{o.label}</span>
                <span className="text-[11px] text-muted-foreground">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>,
          document.body
        )}
    </>
  )
}
