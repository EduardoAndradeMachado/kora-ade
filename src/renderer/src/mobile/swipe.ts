import { useEffect, useRef } from 'react'

// Até aqui o dedo ainda pode estar só tocando; passou disso, o primeiro rumo decide se é rolagem vertical.
const SLOP = 10
const MIN_DISTANCE = 72
const MAX_DURATION_MS = 700
// O arrastar precisa andar na horizontal pelo menos o dobro do maior desvio vertical.
const DOMINANCE = 2

export type SwipeDirection = 'left' | 'right'
export type SwipeActions = Partial<Record<SwipeDirection, () => void>>

// Dedo para a esquerda rola o conteúdo para a direita (scrollLeft cresce); para a direita, o contrário.
function scrollsHorizontally(from: Element, root: Element, direction: SwipeDirection): boolean {
  for (let element: Element | null = from; element && element !== root.parentElement; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth + 1) continue
    const overflow = getComputedStyle(element).overflowX
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    if (direction === 'left' ? Math.ceil(element.scrollLeft + element.clientWidth) < element.scrollWidth : element.scrollLeft > 0) return true
  }
  return false
}

interface Gesture { x: number; y: number; time: number; vertical: number; locked: boolean; blocked: Record<SwipeDirection, boolean> }

// Arrastar de lado com um dedo navega; rolagem vertical, pinça, seleção de texto e áreas que ainda rolam de lado não.
// Eventos de toque passivos, e não de ponteiro: o navegador cancela o ponteiro quando assume a rolagem, e
// touch-action: pan-y travaria a rolagem horizontal do código largo e do PDF ampliado. Captura, porque o xterm não
// deixa o toque subir.
export function useSwipe(element: HTMLElement | null, actions: SwipeActions): void {
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!element) return
    let gesture: Gesture | null = null
    const start = (event: TouchEvent): void => {
      gesture = null
      const touch = event.touches[0]
      const target = event.target
      if (event.touches.length !== 1 || !touch || !(target instanceof Element)) return
      if ((window.visualViewport?.scale ?? 1) > 1.01) return
      if (target.closest('textarea, input, select, [data-no-swipe]') || element.querySelector('[data-swipe-lock]')) return
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        time: event.timeStamp,
        vertical: 0,
        locked: false,
        blocked: { left: scrollsHorizontally(target, element, 'left'), right: scrollsHorizontally(target, element, 'right') }
      }
    }
    const move = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (!gesture) return
      if (event.touches.length !== 1 || !touch) { gesture = null; return }
      const dx = touch.clientX - gesture.x
      const dy = touch.clientY - gesture.y
      gesture.vertical = Math.max(gesture.vertical, Math.abs(dy))
      if (!gesture.locked && Math.hypot(dx, dy) > SLOP) {
        if (Math.abs(dy) >= Math.abs(dx)) { gesture = null; return }
        gesture.locked = true
      }
    }
    const end = (event: TouchEvent): void => {
      const done = gesture
      gesture = null
      const touch = event.changedTouches[0]
      if (!done || !touch || event.touches.length > 0) return
      const dx = touch.clientX - done.x
      const vertical = Math.max(done.vertical, Math.abs(touch.clientY - done.y))
      if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < vertical * DOMINANCE || event.timeStamp - done.time > MAX_DURATION_MS) return
      if (!(window.getSelection()?.isCollapsed ?? true)) return
      const direction: SwipeDirection = dx < 0 ? 'left' : 'right'
      if (done.blocked[direction]) return
      latest.current[direction]?.()
    }
    const cancel = (): void => { gesture = null }
    const options = { passive: true, capture: true }
    element.addEventListener('touchstart', start, options)
    element.addEventListener('touchmove', move, options)
    element.addEventListener('touchend', end, options)
    element.addEventListener('touchcancel', cancel, options)
    return () => {
      element.removeEventListener('touchstart', start, options)
      element.removeEventListener('touchmove', move, options)
      element.removeEventListener('touchend', end, options)
      element.removeEventListener('touchcancel', cancel, options)
    }
  }, [element])
}
