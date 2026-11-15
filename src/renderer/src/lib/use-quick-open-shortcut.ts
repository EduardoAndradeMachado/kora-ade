import { useEffect, useRef } from 'react'

// Ctrl+P abre o "ir para arquivo" de qualquer lugar, menos do terminal: lá a tecla é do processo (no shell e nos
// agentes, Ctrl+P é o "comando anterior"). Na captura para o Monaco não ficar com ela.
export function useQuickOpenShortcut(onOpen: () => void): void {
  const latest = useRef(onOpen)
  latest.current = onOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.code !== 'KeyP' || e.repeat) return
      if (document.activeElement?.closest('.xterm')) return
      e.preventDefault()
      e.stopPropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
