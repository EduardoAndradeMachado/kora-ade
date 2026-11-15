import { describe, expect, it } from 'vitest'
import { parseQuery, rankFiles } from '../src/renderer/src/lib/quick-open'

const FILES = [
  'src\\renderer\\src\\components\\TabBar.tsx',
  'src\\renderer\\src\\components\\Sidebar.tsx',
  'src\\renderer\\src\\App.tsx',
  'src\\main\\index.ts',
  'tabela\\notas.md',
  'docs\\app-store.md',
  'test\\app.test.ts'
]

describe('rankFiles', () => {
  it('põe primeiro o arquivo cujo nome bate, antes do que só bate pela pasta', () => {
    const ranked = rankFiles(FILES, 'tab', [])
    expect(ranked[0]).toBe('src\\renderer\\src\\components\\TabBar.tsx')
    expect(ranked.indexOf('tabela\\notas.md')).toBeGreaterThan(0)
  })

  it('casa letras soltas na ordem, puxando começo de palavra e camelCase', () => {
    expect(rankFiles(FILES, 'tb', [])[0]).toBe('src\\renderer\\src\\components\\TabBar.tsx')
    expect(rankFiles(['src\\fobar.ts', 'src\\fooBar.ts', 'src\\fo-bar.ts'], 'fb', []).slice(0, 2).sort()).toEqual(['src\\fo-bar.ts', 'src\\fooBar.ts'])
    expect(rankFiles(FILES, 'xyz', [])).toEqual([])
  })

  it('com barra na busca, compara com o caminho inteiro', () => {
    expect(rankFiles(FILES, 'main/ind', [])).toEqual(['src\\main\\index.ts'])
  })

  it('busca vazia mostra os recentes primeiro, na ordem em que foram vistos', () => {
    const ranked = rankFiles(FILES, '', ['src\\main\\index.ts', 'docs\\app-store.md'])
    expect(ranked.slice(0, 3)).toEqual(['src\\main\\index.ts', 'docs\\app-store.md', 'src\\renderer\\src\\components\\TabBar.tsx'])
    expect(ranked).toHaveLength(FILES.length)
  })

  it('no empate de pontos, o recente vence', () => {
    const files = ['a\\app.ts', 'b\\app.ts']
    expect(rankFiles(files, 'app', [])[0]).toBe('a\\app.ts')
    expect(rankFiles(files, 'app', ['b\\app.ts'])[0]).toBe('b\\app.ts')
  })

  it('recente com "/" não duplica o mesmo arquivo da listagem', () => {
    expect(rankFiles(FILES, 'index', ['src/main/index.ts'])).toEqual(['src/main/index.ts'])
  })
})

describe('parseQuery', () => {
  it('separa :linha e :linha:coluna do texto da busca', () => {
    expect(parseQuery('src/app.ts:42')).toEqual({ query: 'src/app.ts', line: 42 })
    expect(parseQuery(' app.ts:7:3 ')).toEqual({ query: 'app.ts', line: 7 })
    expect(parseQuery('app.ts')).toEqual({ query: 'app.ts', line: null })
    expect(parseQuery('C:\\x\\a.ts')).toEqual({ query: 'C:\\x\\a.ts', line: null })
  })
})
