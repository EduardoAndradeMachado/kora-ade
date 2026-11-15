import { describe, expect, it } from 'vitest'
import { terminalDropText, treeDragPaths } from '../src/renderer/src/lib/terminal-drop'

describe('soltar arquivos no terminal', () => {
  it('vários caminhos: aspas só em quem tem espaço, separados por espaço', () => {
    expect(terminalDropText(['C:\\proj\\a.ts', 'C:\\proj\\minha pasta\\b c.md', 'C:\\proj\\d.png'])).toBe(
      'C:\\proj\\a.ts "C:\\proj\\minha pasta\\b c.md" C:\\proj\\d.png '
    )
  })

  it('um caminho só, com e sem espaço; nada para colar vira texto vazio', () => {
    expect(terminalDropText(['C:\\proj\\a.ts'])).toBe('C:\\proj\\a.ts ')
    expect(terminalDropText(['C:\\Meus Documentos\\a.ts'])).toBe('"C:\\Meus Documentos\\a.ts" ')
    expect(terminalDropText(['', ''])).toBe('')
  })

  it('lista vinda da árvore pelo JSON; sem ela, vale o text/plain', () => {
    const paths = ['C:\\proj\\a b.ts', 'C:\\proj\\c.ts']
    expect(treeDragPaths(JSON.stringify(paths), '"C:\\proj\\a b.ts" C:\\proj\\c.ts')).toEqual(paths)
    expect(treeDragPaths('', 'C:\\proj\\um arquivo.ts')).toEqual(['C:\\proj\\um arquivo.ts'])
    expect(treeDragPaths('{quebrado', 'C:\\proj\\x.ts')).toEqual(['C:\\proj\\x.ts'])
    expect(treeDragPaths('[1, 2]', '')).toEqual([])
  })
})
