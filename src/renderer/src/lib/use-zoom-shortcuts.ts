import { useEffect } from 'react'

type Direction = 1 | -1 | 0

const KEY_DIRECTION: Record<string, Direction> = {
  Equal: 1,
  NumpadAdd: 1,
  Minus: -1,
  NumpadSubtract: -1,
  Digit0: 0,
  Numpad0: 0
}

// Ctrl ± / 0 → interface inteira; com Shift → só o texto do terminal. Ctrl + roda: sobre o terminal
// muda o texto dele, sobre um arquivo aberto o texto dos arquivos, no resto do app o zoom. Escuta na
// captura da janela para o xterm e o Monaco não engolirem as teclas antes.
export function useZoomShortcuts(
  onZoom: (d: Direction) => void,
  onTerminalFont: (d: Direction) => void,
  onFileFont: (d: Direction) => void
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const direction = KEY_DIRECTION[e.code]
      if (direction === undefined) return
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) onTerminalFont(direction)
      else onZoom(direction)
    }
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey || e.deltaY === 0) return
      e.preventDefault()
      const direction: Direction = e.deltaY < 0 ? 1 : -1
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.xterm')) onTerminalFont(direction)
      else if (target?.closest('[data-file-text]')) onFileFont(direction)
      else onZoom(direction)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [onZoom, onTerminalFont, onFileFont])
}
