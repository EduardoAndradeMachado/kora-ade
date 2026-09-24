import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem = { label: string; onSelect(): void; danger?: boolean } | 'separator'

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

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
            onClick={() => {
              onClose()
              item.onSelect()
            }}
            className={
              item.danger
                ? 'block w-full rounded-md px-2 py-1 text-left text-xs text-destructive hover:bg-secondary'
                : 'block w-full rounded-md px-2 py-1 text-left text-xs hover:bg-secondary'
            }
          >
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
