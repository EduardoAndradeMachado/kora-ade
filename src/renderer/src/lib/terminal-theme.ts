import type { ITheme } from '@xterm/xterm'

const DARK: ITheme = {
  background: '#1f2126',
  foreground: '#d3d6de',
  cursor: '#d3d6de',
  cursorAccent: '#1f2126',
  selectionBackground: '#7d95e84d',
  black: '#1a1c21',
  red: '#e5575f',
  green: '#46c28a',
  yellow: '#dcb45a',
  blue: '#5a8ff0',
  magenta: '#c27de0',
  cyan: '#40b8cc',
  white: '#d3d6de',
  brightBlack: '#6c717d',
  brightRed: '#f47a80',
  brightGreen: '#63d9a2',
  brightYellow: '#ecc977',
  brightBlue: '#7fa9f6',
  brightMagenta: '#d69cec',
  brightCyan: '#65cfdf',
  brightWhite: '#f2f4f7'
}

// No fundo claro, "white"/"brightWhite" dos programas (pensados para fundo escuro) viram cinzas escuros
// e o amarelo escurece; senão o texto que o Claude/Codex pintam de branco some.
const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f2126',
  cursor: '#1f2126',
  cursorAccent: '#ffffff',
  selectionBackground: '#6f86d640',
  black: '#1f2126',
  red: '#c4262f',
  green: '#1a7f37',
  yellow: '#8a6d00',
  blue: '#1f5fcc',
  magenta: '#9a36b0',
  cyan: '#0f7c8c',
  white: '#5c606b',
  brightBlack: '#7a7f89',
  brightRed: '#d73a42',
  brightGreen: '#22863a',
  brightYellow: '#9c7a00',
  brightBlue: '#2f6fe0',
  brightMagenta: '#ad48c4',
  brightCyan: '#1590a3',
  brightWhite: '#3b3f47'
}

export interface TerminalLook {
  theme: ITheme
  // O xterm corrige na hora de desenhar qualquer cor abaixo desse contraste com o fundo;
  // no claro isso protege até de cores que o agente escolha e não passem pela paleta.
  minimumContrastRatio: number
}

const isDark = (): boolean => document.documentElement.classList.contains('dark')

export const currentTerminalLook = (): TerminalLook =>
  isDark() ? { theme: DARK, minimumContrastRatio: 1 } : { theme: LIGHT, minimumContrastRatio: 4.5 }

export function onThemeChange(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
