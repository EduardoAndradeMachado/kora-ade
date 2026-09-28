import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

// Dica na identidade do app no lugar do `title` nativo do Windows. Qualquer elemento com `data-tip` ganha a dica;
// texto com várias linhas vira título (1ª linha) e explicação (o resto). `data-tip-detail` e `data-tip-shortcut`
// dão a explicação e o atalho explicitamente. Botão só com ícone precisa também de `aria-label`: o `title`
// era o nome acessível dele.

const DELAY_MS = 450
// Passando de um elemento para o vizinho logo em seguida, a dica troca na hora, sem esperar de novo.
const WARM_MS = 400
const GAP = 6
const MARGIN = 8

interface Shown {
  el: Element
  anchor: DOMRect
  label: string
  detail?: string
  shortcut?: string
}

function read(el: Element): Omit<Shown, 'el' | 'anchor'> | null {
  const text = el.getAttribute('data-tip')?.trim()
  if (!text) return null
  const [label = '', ...rest] = text.split('\n')
  const detail = el.getAttribute('data-tip-detail') ?? (rest.join('\n').trim() || undefined)
  return { label, detail, shortcut: el.getAttribute('data-tip-shortcut') ?? undefined }
}

export function TipLayer(): React.JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    let current: Element | null = null
    // Depois de um clique a dica só volta quando o mouse sai do elemento e entra de novo, como a nativa.
    let clicked: Element | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let hiddenAt = 0

    const hide = (): void => {
      clearTimeout(timer)
      if (current) hiddenAt = Date.now()
      current = null
      setShown(null)
    }

    const open = (el: Element): void => {
      const content = read(el)
      if (!content || !el.isConnected) return hide()
      setShown({ el, anchor: el.getBoundingClientRect(), ...content })
    }

    const onOver = (e: MouseEvent): void => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null
      if (el === current || (el !== null && el === clicked)) return
      clicked = null
      const warm = current !== null || Date.now() - hiddenAt < WARM_MS
      hide()
      if (!el) return
      current = el
      if (warm) open(el)
      else timer = setTimeout(() => current === el && open(el), DELAY_MS)
    }

    const onOut = (e: MouseEvent): void => {
      const stays = (el: Element | null): boolean => e.relatedTarget instanceof Node && el !== null && el.contains(e.relatedTarget)
      if (clicked && !stays(clicked)) clicked = null
      if (current && !stays(current)) hide()
    }

    const onDown = (e: MouseEvent): void => {
      clicked = current ?? (e.target instanceof Element ? e.target.closest('[data-tip]') : null)
      hide()
    }

    // Elemento que some de baixo do mouse (linha que saiu da lista, aba fechada) leva a dica junto.
    const watch = setInterval(() => current && !current.isConnected && hide(), 250)

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      clearInterval(watch)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  return shown ? <Bubble key={shown.label + shown.anchor.x + shown.anchor.y} {...shown} /> : null
}

function Bubble({ anchor, label, detail, shortcut }: Shown): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number; below: boolean } | null>(null)

  // Embaixo do elemento, centralizada; sem espaço embaixo vai para cima. Nunca sai da janela pelos lados.
  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect()
    const center = anchor.left + anchor.width / 2
    const left = Math.min(Math.max(center - box.width / 2, MARGIN), window.innerWidth - box.width - MARGIN)
    const below = anchor.bottom + GAP + box.height <= window.innerHeight - MARGIN
    const top = below ? anchor.bottom + GAP : anchor.top - GAP - box.height
    setPlace({ left, top, arrow: Math.min(Math.max(center - left, 10), box.width - 10), below })
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: 0 }}
      className="pointer-events-none fixed z-[70] max-w-72 rounded-lg border bg-card px-2.5 py-1.5 text-xs shadow-xl"
    >
      <span
        aria-hidden="true"
        style={{ left: (place?.arrow ?? 0) - 4 }}
        className={cn(
          'absolute size-2 rotate-45 border bg-card',
          place?.below === false ? '-bottom-[5px] border-l-0 border-t-0' : '-top-[5px] border-b-0 border-r-0'
        )}
      />
      <span className="flex items-center gap-2">
        <span className="break-words font-medium text-foreground">{label}</span>
        {shortcut && (
          <kbd className="ml-auto shrink-0 rounded border bg-secondary px-1 font-sans text-[10px] leading-4 text-muted-foreground">
            {shortcut}
          </kbd>
        )}
      </span>
      {detail && <span className="mt-0.5 block whitespace-pre-line break-words leading-snug text-muted-foreground">{detail}</span>}
    </div>,
    document.body
  )
}
