import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

// `shortcut` só como texto ("F2", "Ctrl+K Ctrl+Shift+C"): quem monta o menu é que faz a tecla funcionar.
// `disabled`: o item aparece apagado e não responde, como o "Colar" do VS Code sem nada copiado.
export type MenuItem =
  | { label: string; onSelect(): void; danger?: boolean; icon?: React.ReactNode; shortcut?: string; disabled?: boolean }
  | 'separator'

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const withIcons = items.some((item) => item !== 'separator' && item.icon)

  // Mantém o menu inteiro dentro da janela quando o clique é perto da borda.
  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect()
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 4),
      y: Math.min(y, window.innerHeight - rect.height - 4)
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-52 rounded-lg border bg-card p-1 shadow-xl"
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`sep-${i}`} className="my-1 border-t" />
        ) : (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
            className={cn(
              'flex w-full items-center rounded-md px-2 py-1 text-left text-xs',
              item.disabled ? 'cursor-default opacity-50' : 'hover:bg-secondary',
              withIcons && !item.disabled && 'gap-2 hover:[--icon-accent-idle:var(--icon-accent)]',
              withIcons && item.disabled && 'gap-2',
              item.danger && 'text-destructive'
            )}
          >
            {withIcons && (
              <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center', !item.danger && 'text-muted-foreground')}>
                {item.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && <kbd className="ml-auto shrink-0 pl-6 font-sans text-[11px] text-muted-foreground">{item.shortcut}</kbd>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
