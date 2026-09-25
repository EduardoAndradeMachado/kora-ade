import { useEffect } from 'react'

// Os botões de janela (minimizar, maximizar, fechar) são desenhados pelo Windows, fora da página: o véu escuro
// dos diálogos não os cobre e eles ficavam claros por cima dele. Cada diálogo aberto pede o escurecimento e o
// último a fechar devolve, então diálogos empilhados não se atropelam.
let open = 0

export function useWindowDim(active = true): void {
  useEffect(() => {
    if (!active) return
    if (open++ === 0) window.kora.setWindowDimmed(true)
    return () => {
      if (--open === 0) window.kora.setWindowDimmed(false)
    }
  }, [active])
}
