import { describe, expect, it } from 'vitest'
import { screenText } from '../src/shared/scrollback'

function buffer(lines: string[]): { length: number; getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } {
  return {
    length: lines.length,
    getLine: (y) => (lines[y] === undefined ? undefined : { translateToString: (trimRight) => (trimRight ? lines[y]!.trimEnd() : lines[y]!) })
  }
}

describe('screenText', () => {
  it('junta as linhas do buffer e descarta o branco das pontas', () => {
    expect(screenText(buffer(['', '   ', 'primeira', '', 'segunda', '  ', '']))).toBe('primeira\n\nsegunda')
  })

  it('não corta linha em branco no meio do conteúdo', () => {
    expect(screenText(buffer(['um', '', 'dois']))).toBe('um\n\ndois')
  })

  it('terminal vazio vira texto vazio', () => {
    expect(screenText(buffer(['', '   ', '']))).toBe('')
  })

  it('linha que o xterm não devolve não vira lixo', () => {
    const parcial = { length: 2, getLine: (y: number) => (y === 1 ? undefined : { translateToString: () => 'a' }) }
    expect(screenText(parcial)).toBe('a')
  })
})
