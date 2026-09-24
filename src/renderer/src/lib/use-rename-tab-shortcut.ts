import { useEffect, useRef } from 'react'

// F2 renomeia a aba atual, inclusive com o foco no terminal (lá o F2 do PSReadLine, que troca a vista das
// sugestões, deixa de chegar). Fica de fora onde F2 já tem dono: o editor (renomear símbolo), campos de texto
// e o explorador, que usa F2 para renomear o item selecionado.
export function useRenameTabShortcut(onRename: () => void): void {
  const latest = useRef(onRename)
  latest.current = onRename
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F2' || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.monaco-editor, [data-file-tree]')) return
      const typing = target instanceof HTMLInputElement || (target instanceof HTMLTextAreaElement && !target.classList.contains('xterm-helper-textarea'))
      if (typing) return
      e.preventDefault()
      e.stopPropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
