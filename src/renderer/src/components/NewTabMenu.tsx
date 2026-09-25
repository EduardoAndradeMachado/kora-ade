import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/brand/icons'
import { AgentIcon } from '@/components/AgentIcon'
import { cn } from '@/lib/utils'

export type NewTabChoice = 'shell' | 'claude' | 'codex' | 'existing'

const OPTIONS: { choice: NewTabChoice; label: string; hint: string }[] = [
  { choice: 'claude', label: 'Claude', hint: 'sessão nova, já vinculada à aba' },
  { choice: 'codex', label: 'Codex', hint: 'sessão nova, vínculo detectado' },
  { choice: 'shell', label: 'Terminal', hint: 'PowerShell na pasta do projeto' },
  { choice: 'existing', label: 'Sessão existente', hint: 'fixar uma sessão pelo ID' }
]

interface Props {
  onChoose(choice: NewTabChoice): void
  className?: string
  iconClassName?: string
}

export function NewTabMenu({ onChoose, className, iconClassName }: Props): React.JSX.Element {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!pos) return
    const close = (): void => setPos(null)
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
  }, [pos])

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (pos) return setPos(null)
    const rect = buttonRef.current!.getBoundingClientRect()
    const width = 240
    setPos({ x: Math.min(rect.left, window.innerWidth - width - 8), y: rect.bottom + 4 })
  }

  return (
    <>
      <button ref={buttonRef} type="button" title="Nova aba" onClick={toggle} className={className}>
        <Icon name="novaAba" className={iconClassName ?? 'size-4'} />
      </button>
      {pos &&
        createPortal(
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: pos.x, top: pos.y, width: 240 }}
          className="fixed z-50 rounded-lg border bg-card p-1 shadow-xl"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.choice}
              type="button"
              onClick={() => {
                setPos(null)
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
