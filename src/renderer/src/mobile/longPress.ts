import { useRef } from 'react'

const HOLD_MS = 450
const MOVE_TOLERANCE = 10

type PressHandlers = Pick<React.HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onPointerLeave' | 'onContextMenu'>

// Ao soltar o dedo, o navegador manda o clique para o que estiver embaixo: a folha que acabou de abrir por
// cima, que fecharia na hora. Vale só para o clique desse mesmo toque.
function swallowReleaseClick(): void {
  const swallow = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    stop()
  }
  const released = (): void => void window.setTimeout(stop, 400)
  const stop = (): void => {
    window.removeEventListener('click', swallow, true)
    window.removeEventListener('pointerup', released, true)
  }
  window.addEventListener('click', swallow, true)
  window.addEventListener('pointerup', released, true)
}

// Toque longo abre as opções do item; o toque curto continua sendo o clique normal.
export function useLongPress(): (onHold: () => void) => PressHandlers {
  const press = useRef<{ timer: number; x: number; y: number; touch: boolean } | null>(null)
  const held = useRef(false)
  const cancel = (): void => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  return (onHold) => ({
    onPointerDown: (event) => {
      cancel()
      held.current = false
      const timer = window.setTimeout(() => {
        press.current = null
        held.current = true
        navigator.vibrate?.(10)
        swallowReleaseClick()
        onHold()
      }, HOLD_MS)
      press.current = { timer, x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse' }
    },
    onPointerMove: (event) => {
      if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > MOVE_TOLERANCE) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    // O Chrome do Android dispara o menu do sistema no mesmo toque longo; no PC, é o clique direito, que não gera clique.
    onContextMenu: (event) => {
      event.preventDefault()
      if (held.current) return
      const touch = press.current?.touch ?? false
      cancel()
      held.current = true
      if (touch) swallowReleaseClick()
      onHold()
    }
  })
}
