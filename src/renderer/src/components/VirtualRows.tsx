import { useLayoutEffect, useRef, useState } from 'react'
import { keepMounted, visibleRange, type RowRange } from '@/lib/virtual-range'

const OVERSCAN = 20
const STEP = 10

export interface VirtualRowsApi {
  // Rola o mínimo para a linha aparecer, como scrollIntoView({ block: 'nearest' }); funciona com ela fora do DOM.
  scrollToIndex(index: number): void
}

// Todo ancestral que corta o conteúdo. Não dá para pegar só o mais próximo com overflow: no painel do Git o
// `overflow-y-auto` de dentro cresce com o conteúdo e quem rola é o de fora.
function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = []
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== 'visible') found.push(node)
  }
  return found
}

// Com milhares de itens, montar todas as linhas custava segundos por render e dezenas de milhares de elementos.
// Só as linhas perto da área visível existem; o resto é altura vazia.
export function VirtualRows<T>({
  items,
  rowHeight,
  render,
  apiRef,
  keepIndex
}: {
  items: T[]
  rowHeight: number
  render(item: T): React.ReactNode
  apiRef?: React.RefObject<VirtualRowsApi | null>
  // Índice que fica montado mesmo fora da área visível.
  keepIndex?: number
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState<RowRange>(() => ({ start: 0, end: Math.min(items.length, OVERSCAN * 2) }))
  const updateRef = useRef<() => void>(() => {})
  const count = items.length

  useLayoutEffect(() => {
    const list = ref.current
    if (!list) return
    const clips = clippingAncestors(list)
    const update = (): void => {
      let top = 0
      let bottom = window.innerHeight
      for (const clip of clips) {
        const box = clip.getBoundingClientRect()
        top = Math.max(top, box.top)
        bottom = Math.min(bottom, box.bottom)
      }
      const listTop = list.getBoundingClientRect().top
      const next = visibleRange(top, Math.max(bottom - top, 0), listTop, count, rowHeight, OVERSCAN, STEP)
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    }
    updateRef.current = update
    update()
    // Captura: o evento de rolagem não sobe, e não importa qual ancestral rolou. Rolagem de outra coisa (um terminal
    // despejando saída rola a cada linha) não mexe na lista e não deve medir layout.
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && e.target !== document && !e.target.contains(list)) return
      update()
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', update)
    const resize = new ResizeObserver(update)
    clips.forEach((clip) => resize.observe(clip))
    if (apiRef) {
      apiRef.current = {
        scrollToIndex: (index) => {
          const scroller = clips.find((clip) => /auto|scroll/.test(getComputedStyle(clip).overflowY) && clip.scrollHeight > clip.clientHeight + 1)
          if (!scroller || index < 0 || index >= count) return
          const box = scroller.getBoundingClientRect()
          const rowTop = list.getBoundingClientRect().top + index * rowHeight
          if (rowTop < box.top) scroller.scrollTop -= box.top - rowTop
          else if (rowTop + rowHeight > box.bottom) scroller.scrollTop += rowTop + rowHeight - box.bottom
          update()
        }
      }
    }
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', update)
      resize.disconnect()
      updateRef.current = () => {}
      if (apiRef) apiRef.current = null
    }
  }, [count, rowHeight, apiRef])

  // Seção de cima abrindo ou fechando (branches, stash) muda onde a lista começa sem rolar nada.
  useLayoutEffect(() => updateRef.current())

  const mounted = keepMounted(range, keepIndex, count)
  return (
    <div ref={ref} style={{ height: count * rowHeight }} className="relative">
      <div style={{ transform: `translateY(${mounted.start * rowHeight}px)` }}>{items.slice(mounted.start, mounted.end).map(render)}</div>
    </div>
  )
}
