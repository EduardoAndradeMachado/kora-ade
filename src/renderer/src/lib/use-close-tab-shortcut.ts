import { useEffect, useRef } from 'react'

// Ctrl+W (com ou sem Shift) fecha a aba, não a janela. Custa o "apagar palavra" do Ctrl+W no shell e nos
// agentes. Na captura para o xterm e o Monaco não ficarem com a tecla.
export function useCloseTabShortcut(onClose: () => void): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.code !== 'KeyW' || e.repeat) return
      e.preventDefault()
      e.stopPropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
