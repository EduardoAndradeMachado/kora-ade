import { useEffect, useRef } from 'react'

export type TabCommand =
  | 'close'
  | 'closeAll'
  | 'closeSaved'
  | 'keepOpen'
  | 'copyPath'
  | 'copyRelativePath'
  | 'revealInExplorer'
  | 'reopenClosed'
  | 'nextFile'
  | 'previousFile'

// Os mesmos atalhos do VS Code no Windows; aparecem também no menu da aba.
export const TAB_SHORTCUT_LABEL: Record<Exclude<TabCommand, 'nextFile' | 'previousFile' | 'reopenClosed'>, string> = {
  close: 'Ctrl+W',
  closeAll: 'Ctrl+K Ctrl+W',
  closeSaved: 'Ctrl+K U',
  keepOpen: 'Ctrl+K Enter',
  copyPath: 'Shift+Alt+C',
  copyRelativePath: 'Ctrl+K Ctrl+Shift+C',
  revealInExplorer: 'Shift+Alt+R'
}

export interface KeyPress {
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export interface KeyContext {
  // Ctrl+K apertado logo antes: a tecla de agora é a segunda do acorde.
  chord: boolean
  inTerminal: boolean
  // A árvore tem os próprios Shift+Alt+C e Shift+Alt+R, para o item selecionado nela.
  inTree: boolean
}

// 'chord' é o Ctrl+K: não faz nada sozinho, espera a próxima tecla.
export function tabShortcut(key: KeyPress, ctx: KeyContext): TabCommand | 'chord' | null {
  if (key.metaKey) return null
  const { code, ctrlKey: ctrl, shiftKey: shift, altKey: alt } = key
  // Ctrl+W fecha a aba mesmo com o foco no terminal, como sempre foi no Kora (custa o "apagar palavra" do shell).
  if (ctrl && !alt && code === 'KeyW') return ctx.chord ? 'closeAll' : 'close'
  if (ctx.inTerminal) return null
  if (ctx.chord) {
    if (!ctrl && !shift && !alt && (code === 'Enter' || code === 'NumpadEnter')) return 'keepOpen'
    if (!ctrl && !shift && !alt && code === 'KeyU') return 'closeSaved'
    if (ctrl && shift && !alt && code === 'KeyC') return ctx.inTree ? null : 'copyRelativePath'
    return null
  }
  if (ctrl && !shift && !alt && code === 'KeyK') return 'chord'
  if (!ctrl && shift && alt && code === 'KeyC') return ctx.inTree ? null : 'copyPath'
  if (!ctrl && shift && alt && code === 'KeyR') return ctx.inTree ? null : 'revealInExplorer'
  if (ctrl && shift && !alt && code === 'KeyT') return 'reopenClosed'
  if (ctrl && !shift && !alt && code === 'PageDown') return 'nextFile'
  if (ctrl && !shift && !alt && code === 'PageUp') return 'previousFile'
  return null
}

const MODIFIER = new Set(['Control', 'Shift', 'Alt', 'Meta'])

// Na captura, para o Monaco e o xterm não ficarem com as teclas. O Ctrl+K e a segunda tecla do acorde seguem para o
// Monaco: ele também tem acordes com Ctrl+K e, sem ver a segunda tecla, ficaria esperando e engoliria a próxima.
export function useTabShortcuts(run: (command: TabCommand) => void): void {
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    let chord = false
    const onKey = (e: KeyboardEvent): void => {
      if (MODIFIER.has(e.key)) return
      const focus = document.activeElement
      const ctx: KeyContext = { chord, inTerminal: Boolean(focus?.closest('.xterm')), inTree: Boolean(focus?.closest('[data-file-tree]')) }
      chord = false
      const command = tabShortcut(e, ctx)
      if (!command) return
      if (command === 'chord') {
        chord = true
        return
      }
      e.preventDefault()
      if (!ctx.chord) e.stopPropagation()
      if (e.repeat && command !== 'nextFile' && command !== 'previousFile') return
      latest.current(command)
    }
    const reset = (): void => {
      chord = false
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', reset)
    window.addEventListener('mousedown', reset, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', reset)
      window.removeEventListener('mousedown', reset, true)
    }
  }, [])
}
