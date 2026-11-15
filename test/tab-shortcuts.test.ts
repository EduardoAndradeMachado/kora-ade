import { describe, expect, it } from 'vitest'
import { tabShortcut, type KeyContext, type KeyPress } from '../src/renderer/src/lib/use-tab-shortcuts'

const key = (code: string, mods: Partial<Omit<KeyPress, 'code'>> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods
})
const at = (ctx: Partial<KeyContext> = {}): KeyContext => ({ chord: false, inTerminal: false, inTree: false, ...ctx })

describe('tabShortcut', () => {
  it('teclas do VS Code no Windows', () => {
    expect(tabShortcut(key('KeyW', { ctrlKey: true }), at())).toBe('close')
    expect(tabShortcut(key('KeyC', { shiftKey: true, altKey: true }), at())).toBe('copyPath')
    expect(tabShortcut(key('KeyR', { shiftKey: true, altKey: true }), at())).toBe('revealInExplorer')
    expect(tabShortcut(key('KeyT', { ctrlKey: true, shiftKey: true }), at())).toBe('reopenClosed')
    expect(tabShortcut(key('PageDown', { ctrlKey: true }), at())).toBe('nextFile')
    expect(tabShortcut(key('PageUp', { ctrlKey: true }), at())).toBe('previousFile')
  })

  it('acordes com Ctrl+K: a segunda tecla decide; sem o Ctrl+K antes, as mesmas teclas não fazem nada', () => {
    expect(tabShortcut(key('KeyK', { ctrlKey: true }), at())).toBe('chord')
    expect(tabShortcut(key('KeyW', { ctrlKey: true }), at({ chord: true }))).toBe('closeAll')
    expect(tabShortcut(key('Enter'), at({ chord: true }))).toBe('keepOpen')
    expect(tabShortcut(key('KeyU'), at({ chord: true }))).toBe('closeSaved')
    expect(tabShortcut(key('KeyC', { ctrlKey: true, shiftKey: true }), at({ chord: true }))).toBe('copyRelativePath')
    expect(tabShortcut(key('Enter'), at())).toBeNull()
    expect(tabShortcut(key('KeyU'), at())).toBeNull()
    expect(tabShortcut(key('KeyC', { ctrlKey: true, shiftKey: true }), at())).toBeNull()
    // Ctrl+K Ctrl+C é o "comentar linha" do Monaco: o acorde que não é da aba passa adiante.
    expect(tabShortcut(key('KeyC', { ctrlKey: true }), at({ chord: true }))).toBeNull()
  })

  it('com o foco no terminal as teclas são do processo; só o Ctrl+W continua fechando a aba', () => {
    const terminal = at({ inTerminal: true })
    expect(tabShortcut(key('KeyK', { ctrlKey: true }), terminal)).toBeNull()
    expect(tabShortcut(key('KeyC', { shiftKey: true, altKey: true }), terminal)).toBeNull()
    expect(tabShortcut(key('KeyT', { ctrlKey: true, shiftKey: true }), terminal)).toBeNull()
    expect(tabShortcut(key('PageDown', { ctrlKey: true }), terminal)).toBeNull()
    expect(tabShortcut(key('Enter'), at({ inTerminal: true, chord: true }))).toBeNull()
    expect(tabShortcut(key('KeyW', { ctrlKey: true }), terminal)).toBe('close')
  })

  it('na árvore, copiar e revelar ficam com o item selecionado nela', () => {
    const tree = at({ inTree: true })
    expect(tabShortcut(key('KeyC', { shiftKey: true, altKey: true }), tree)).toBeNull()
    expect(tabShortcut(key('KeyR', { shiftKey: true, altKey: true }), tree)).toBeNull()
    expect(tabShortcut(key('KeyC', { ctrlKey: true, shiftKey: true }), at({ inTree: true, chord: true }))).toBeNull()
    expect(tabShortcut(key('KeyW', { ctrlKey: true }), tree)).toBe('close')
  })
})
