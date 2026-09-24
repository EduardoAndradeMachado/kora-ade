import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPathCandidates, splitLineSuffix } from '../src/shared/terminal-links'
import { resolveTerminalLink } from '../src/main/terminal-links'

const texts = (line: string): string[] => findPathCandidates(line).map((c) => c.text)

describe('caminhos no texto do terminal', () => {
  it('acha caminhos relativos, absolutos, com barra invertida e com linha:coluna', () => {
    expect(texts('Editei src/main/index.ts:42 e ./README.md')).toEqual(['src/main/index.ts:42', './README.md'])
    expect(texts('erro em C:\\proj\\app\\x.tsx:10:5 agora')).toEqual(['C:\\proj\\app\\x.tsx:10:5'])
    expect(texts('Update(src\\renderer\\App.tsx)')).toEqual(['src\\renderer\\App.tsx'])
    expect(texts('veja CLAUDE.md.')).toEqual(['CLAUDE.md'])
  })

  it('posição exata na linha, para o sublinhado cair em cima do caminho', () => {
    const [c] = findPathCandidates('  › src/a.ts')
    expect(c).toEqual({ text: 'src/a.ts', start: 4, end: 12 })
  })

  it('pedaço de URL não é caminho de arquivo', () => {
    expect(texts('abra https://example.com/docs/guia.html')).toEqual([])
    expect(texts('http://localhost:5173/src/main.tsx')).toEqual([])
  })

  it('separa o sufixo de linha do caminho', () => {
    expect(splitLineSuffix('src/a.ts:12:3')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLineSuffix('src/a.ts')).toEqual({ path: 'src/a.ts', line: null })
  })
})

describe('resolução no main', () => {
  const root = mkdtempSync(join(tmpdir(), 'kora-links-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'x')
  const outside = mkdtempSync(join(tmpdir(), 'kora-fora-'))
  writeFileSync(join(outside, 'segredo.txt'), 'x')

  it('arquivo do projeto, relativo ou absoluto, vira caminho relativo com a linha', async () => {
    expect(await resolveTerminalLink(root, 'src/a.ts:7')).toEqual({ rel: join('src', 'a.ts'), line: 7 })
    expect(await resolveTerminalLink(root, join(root, 'src', 'a.ts'))).toEqual({ rel: join('src', 'a.ts'), line: null })
  })

  it('não vira link: arquivo inexistente, pasta, fora do projeto', async () => {
    expect(await resolveTerminalLink(root, 'src/b.ts')).toBeNull()
    expect(await resolveTerminalLink(root, 'src')).toBeNull()
    expect(await resolveTerminalLink(root, join(outside, 'segredo.txt'))).toBeNull()
    expect(await resolveTerminalLink(root, '../' + outside.split(/[\\/]/).pop() + '/segredo.txt')).toBeNull()
  })
})
