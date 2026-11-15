import { describe, expect, it } from 'vitest'
import { hasEditMode, mobileViewerFor, sheetOpenDecision, startsInEdit } from '../src/renderer/src/mobile/viewer-kind'
import { foldUnchanged, lineDiff, type DiffLine } from '../src/renderer/src/mobile/line-diff'
import { eventTouches, followAction } from '../src/renderer/src/mobile/file-follow'
import { OPEN_LIMITS } from '../src/shared/open-limits'

describe('visualizador de cada arquivo no celular', () => {
  it('abre como o PC o que o WebView desenha, e só o resto fica para baixar', () => {
    const cases: [string, string][] = [
      ['docs/LEIA.md', 'markdown'], ['site/index.HTML', 'html'], ['a.htm', 'html'], ['logo.svg', 'svg'], ['foto.JPG', 'image'],
      ['dados.csv', 'csv'], ['dados.tsv', 'csv'], ['vendas.xlsx', 'xlsx'], ['analise.ipynb', 'notebook'], ['manual.pdf', 'pdf'],
      ['voz.opus', 'audio'], ['musica.mp3', 'audio'], ['aula.mp4', 'video'], ['tela.webm', 'video'], ['clipe.mov', 'video'],
      ['src/app.ts', 'code'], ['Makefile', 'code'], ['pacote.zip', 'external'], ['velho.xls', 'external'], ['setup.exe', 'external']
    ]
    for (const [path, viewer] of cases) expect(mobileViewerFor(path), path).toBe(viewer)
  })

  it('o que é texto tem o Editar; mídia, PDF, .xlsx e binário não', () => {
    for (const path of ['a.md', 'a.html', 'a.svg', 'a.ts', 'a.csv', 'a.ipynb']) expect(hasEditMode(path), path).toBe(true)
    for (const path of ['a.pdf', 'a.png', 'a.mp4', 'a.mp3', 'a.xlsx', 'a.zip']) expect(hasEditMode(path), path).toBe(false)
  })

  it('a linha pedida pelo terminal abre no texto só o que não mostra a linha na visualização', () => {
    expect(startsInEdit('html', 12)).toBe(true)
    expect(startsInEdit('svg', 3)).toBe(true)
    expect(startsInEdit('notebook', 40)).toBe(true)
    expect(startsInEdit('html', null)).toBe(false)
    for (const viewer of ['markdown', 'code', 'csv', 'pdf'] as const) expect(startsInEdit(viewer, 10), viewer).toBe(false)
  })

  it('planilha segue os degraus de memória do PC: abre, pergunta, só baixando', () => {
    expect(sheetOpenDecision(OPEN_LIMITS.sheetBytes, false)).toBe('open')
    expect(sheetOpenDecision(OPEN_LIMITS.sheetBytes + 1, false)).toBe('ask')
    expect(sheetOpenDecision(OPEN_LIMITS.sheetBytes + 1, true)).toBe('open')
    expect(sheetOpenDecision(OPEN_LIMITS.forcedSheetBytes, true)).toBe('open')
    expect(sheetOpenDecision(OPEN_LIMITS.forcedSheetBytes + 1, true)).toBe('too-large')
  })
})

const show = (lines: DiffLine[]): string[] => lines.map((l) => (l.kind === 'same' ? ' ' : l.kind === 'added' ? '+' : '-') + l.text)

describe('comparação por linhas do rascunho com o PC', () => {
  it('mostra só o que saiu e o que entrou, com o número da linha de cada lado', () => {
    const pc = ['um', 'dois', 'três', 'quatro', 'cinco'].join('\n')
    const mine = ['um', 'DOIS', 'três', 'cinco', 'seis'].join('\r\n')
    const diff = lineDiff(pc, mine)
    expect(show(diff)).toEqual([' um', '-dois', '+DOIS', ' três', '-quatro', ' cinco', '+seis'])
    expect(diff.find((l) => l.kind === 'removed' && l.text === 'quatro')).toMatchObject({ before: 4 })
    expect(diff.find((l) => l.kind === 'added' && l.text === 'seis')).toMatchObject({ after: 5 })
    expect(diff.find((l) => l.kind === 'same' && l.text === 'cinco')).toMatchObject({ before: 5, after: 4 })
  })

  it('linha repetida no meio não vira troca de tudo: acha a maior parte em comum', () => {
    const pc = ['a', 'x', 'b', 'x', 'c'].join('\n')
    const mine = ['a', 'b', 'x', 'c'].join('\n')
    const diff = lineDiff(pc, mine)
    expect(diff.filter((l) => l.kind === 'same').map((l) => l.text)).toEqual(['a', 'b', 'x', 'c'])
    expect(show(diff).filter((l) => l[0] !== ' ')).toEqual(['-x'])
  })

  it('miolo grande demais para a tabela vira tudo removido e tudo adicionado, sem perder o começo e o fim iguais', () => {
    const pc = ['topo', 'a1', 'x', 'a3', 'fim'].join('\n')
    const mine = ['topo', 'b1', 'x', 'fim'].join('\n')
    expect(show(lineDiff(pc, mine, 5))).toEqual([' topo', '-a1', '-x', '-a3', '+b1', '+x', ' fim'])
    expect(show(lineDiff(pc, mine, 6)), 'no teto, ainda pela tabela').toEqual([' topo', '-a1', '+b1', ' x', '-a3', ' fim'])
  })

  it('na tela pequena, trechos iguais longos viram "N linhas iguais" com 3 de vizinhança', () => {
    const pc = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`)
    const mine = [...pc]
    mine[14] = 'mudou'
    const rows = foldUnchanged(lineDiff(pc.join('\n'), mine.join('\n')))
    expect(rows[0]).toEqual({ kind: 'skip', count: 11 })
    expect(rows.slice(1, 4).map((r) => (r.kind === 'same' ? r.text : r.kind))).toEqual(['linha 12', 'linha 13', 'linha 14'])
    expect(rows.slice(4, 6).map((r) => r.kind)).toEqual(['removed', 'added'])
    expect(rows.slice(6, 9).map((r) => (r.kind === 'same' ? r.text : r.kind))).toEqual(['linha 16', 'linha 17', 'linha 18'])
    expect(rows[9]).toEqual({ kind: 'skip', count: 12 })
    expect(rows).toHaveLength(10)
  })
})

describe('arquivo aberto no celular que muda no PC', () => {
  const at = (mtimeMs: number) => ({ exists: true as const, mtimeMs, size: 10 })

  it('sem rascunho recarrega, com rascunho avisa, e a versão que ele já tem não faz nada', () => {
    expect(followAction(100, at(100), false)).toBe('same')
    expect(followAction(100, at(100), true)).toBe('same')
    expect(followAction(100, at(200), false)).toBe('reload')
    expect(followAction(100, at(200), true)).toBe('conflict')
  })

  it('apagado ou renomeado avisa uma vez; voltando com o mesmo nome é versão nova', () => {
    expect(followAction(100, { exists: false }, true)).toBe('gone')
    expect(followAction(100, { exists: false }, false)).toBe('gone')
    expect(followAction(null, { exists: false }, true)).toBe('same')
    expect(followAction(null, at(100), true)).toBe('conflict')
    expect(followAction(null, at(100), false)).toBe('reload')
  })

  it('o aviso do PC só conta para o arquivo aberto, com a barra e a caixa do Windows', () => {
    const event = { projectId: 'p', dirs: [], git: true, rescan: false, files: ['docs\\Nota.MD'], allFiles: false }
    expect(eventTouches(event, 'p', 'docs/nota.md')).toBe(true)
    expect(eventTouches(event, 'p', 'docs/outra.md')).toBe(false)
    expect(eventTouches(event, 'q', 'docs/nota.md')).toBe(false)
    expect(eventTouches({ ...event, files: [], allFiles: true }, 'p', 'docs/outra.md')).toBe(true)
    expect(eventTouches({ ...event, files: [], rescan: true }, 'p', 'docs/outra.md')).toBe(true)
    expect(eventTouches({ projectId: 'p', dirs: ['docs'], git: false, rescan: false }, 'p', 'docs/outra.md'), 'PC sem a lista de arquivos no aviso: confere').toBe(true)
  })
})
