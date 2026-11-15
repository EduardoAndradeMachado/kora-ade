import { useEffect, useRef } from 'react'

// Ctrl+S para a aba cujo editor está escondido atrás de uma visualização (Markdown, SVG): o atalho do Monaco só vale
// com o foco nele. Fase de bolha e defaultPrevented: um Monaco com foco trata a tecla antes e ela não chega aqui.
// No terminal com foco a tecla é do processo que roda nele.
export function useSaveShortcut(active: boolean, save: (() => void) | undefined): void {
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.code !== 'KeyS' || e.defaultPrevented) return
      const focused = document.activeElement
      if (focused instanceof Element && focused.closest('.xterm, .monaco-editor')) return
      e.preventDefault()
      if (!e.repeat) saveRef.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}
