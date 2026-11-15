import { describe, expect, it } from 'vitest'
import {
  changeMayRemove,
  compareTitle,
  diffTitle,
  fileTabsToClose,
  placeDiffTab,
  type GitDiffTarget,
  moveFileTab,
  moveRecentPaths,
  placeCompareTab,
  placeFileTab,
  rememberClosed,
  reopenClosed,
  siblingFileTab,
  tabShowsPathUnder,
  type FileTab
} from '../src/renderer/src/lib/file-tabs'
import type { FilesChange } from '../src/shared/ipc'

type Terminal = { kind: 'terminal'; id: string }
type Any = Terminal | FileTab

const clean = (): boolean => false
const open = (list: Any[], path: string, preview: boolean, isDirty: (t: FileTab) => boolean = clean) =>
  placeFileTab(list, { projectId: 'p', path, viewer: 'code', preview }, isDirty)

const files = (list: Any[]): { path: string; preview: boolean }[] =>
  list.flatMap((t) => (t.kind === 'file' ? [{ path: t.path, preview: t.preview === true }] : []))

describe('placeFileTab', () => {
  it('cliques seguidos em pré-visualização trocam a mesma aba, no mesmo lugar', () => {
    const terminal: Terminal = { kind: 'terminal', id: 't' }
    let list: Any[] = [terminal]
    for (const path of ['a.ts', 'b.ts', 'c.ts']) list = open(list, path, true).list
    expect(list[0]).toBe(terminal)
    expect(files(list)).toEqual([{ path: 'c.ts', preview: true }])
  })

  it('aba de pré-visualização suja não é trocada: o próximo clique abre outra', () => {
    const first = open([], 'a.ts', true)
    const second = open(first.list, 'b.ts', true, (t) => t.id === first.id)
    expect(files(second.list)).toEqual([
      { path: 'a.ts', preview: true },
      { path: 'b.ts', preview: true }
    ])
  })

  it('abrir sem pré-visualização cria aba fixa, que o clique seguinte não toca', () => {
    let list = open([], 'a.ts', false).list
    list = open(list, 'b.ts', true).list
    list = open(list, 'c.ts', true).list
    expect(files(list)).toEqual([
      { path: 'a.ts', preview: false },
      { path: 'c.ts', preview: true }
    ])
  })

  it('arquivo já aberto só é selecionado; pedido sem pré-visualização fixa a aba', () => {
    const first = open([], 'a.ts', true)
    const again = open(first.list, 'a.ts', true)
    expect(again.id).toBe(first.id)
    expect(files(again.list)).toEqual([{ path: 'a.ts', preview: true }])
    const pinned = open(first.list, 'a.ts', false)
    expect(pinned.id).toBe(first.id)
    expect(files(pinned.list)).toEqual([{ path: 'a.ts', preview: false }])
  })

  it('arquivo aberto em aba fixa não vira pré-visualização com clique simples', () => {
    const first = open([], 'a.ts', false)
    expect(files(open(first.list, 'a.ts', true).list)).toEqual([{ path: 'a.ts', preview: false }])
  })

  it('id de aba movida para outro caminho não é reaproveitado pelo arquivo novo', () => {
    const moved: FileTab = { kind: 'file', id: 'file:p:a.ts', title: 'b.ts', path: 'b.ts', viewer: 'code', editing: true, dirty: false }
    const result = open([moved], 'a.ts', false)
    expect(result.id).not.toBe(moved.id)
    expect(new Set(result.list.map((t) => t.id)).size).toBe(2)
  })

  it('aba de diff do mesmo arquivo não conta como aberta', () => {
    const diff: FileTab = { kind: 'file', id: 'diff:x', title: 'a.ts (alterações)', path: 'a.ts', viewer: 'code', editing: false, dirty: false, diff: { staged: false } }
    const result = open([diff], 'a.ts', true)
    expect(result.list).toHaveLength(2)
    expect(result.list[0]).toBe(diff)
  })
})

describe('placeDiffTab', () => {
  const diff = (list: Any[], path: string, target: GitDiffTarget, preview: boolean, isDirty: (t: FileTab) => boolean = clean) =>
    placeDiffTab(list, { projectId: 'p', path, target, preview }, isDirty)
  const diffs = (list: Any[]): { title: string; preview: boolean }[] =>
    list.flatMap((t) => (t.kind === 'file' ? [{ title: t.title, preview: t.preview === true }] : []))

  it('clique simples no Git reaproveita a mesma aba de pré-visualização, inclusive a de um arquivo', () => {
    let list: Any[] = open([], 'x.ts', true).list
    list = diff(list, 'a.ts', { staged: false }, true).list
    list = diff(list, 'b.ts', { staged: true }, true).list
    expect(diffs(list)).toEqual([{ title: 'b.ts (na fila)', preview: true }])
    list = open(list, 'y.ts', true).list
    expect(diffs(list)).toEqual([{ title: 'y.ts', preview: true }])
  })

  it('duplo clique fixa; o mesmo diff de novo só seleciona; fila e alterações do mesmo arquivo são abas diferentes', () => {
    const first = diff([], 'a.ts', { staged: false }, true)
    const pinned = diff(first.list, 'a.ts', { staged: false }, false)
    expect(pinned.id).toBe(first.id)
    expect(diffs(pinned.list)).toEqual([{ title: 'a.ts (alterações)', preview: false }])
    const again = diff(pinned.list, 'a.ts', { staged: false }, true)
    expect(again.id).toBe(first.id)
    const staged = diff(again.list, 'a.ts', { staged: true }, true)
    expect(diffs(staged.list)).toEqual([
      { title: 'a.ts (alterações)', preview: false },
      { title: 'a.ts (na fila)', preview: true }
    ])
  })

  it('não troca aba suja nem a aba do arquivo; diff de commit e arquivo no HEAD têm título e id próprios', () => {
    const edited = open([], 'a.ts', true).list
    const kept = diff(edited, 'a.ts', { staged: false }, true, () => true)
    expect(kept.list).toHaveLength(2)

    const hash = 'abcdef1234567890abcdef1234567890abcdef12'
    const commit = diff([], 'novo.ts', { staged: false, commit: hash, origPath: 'velho.ts' }, false)
    const head = diff(commit.list, 'novo.ts', { staged: false, commit: 'HEAD', fileAt: true }, false)
    expect(diffs(head.list).map((d) => d.title)).toEqual(['velho.ts ↔ novo.ts (abcdef1)', 'novo.ts (HEAD)'])
    expect(new Set(head.list.map((t) => t.id)).size).toBe(2)
    expect(diffTitle('novo.ts', { staged: true, origPath: 'velho.ts' })).toBe('velho.ts ↔ novo.ts (na fila)')
  })
})

describe('fileTabsToClose', () => {
  const tab = (id: string): FileTab => ({ kind: 'file', id, title: id, path: id, viewer: 'code', editing: true, dirty: false })
  const list: Any[] = [tab('a'), { kind: 'terminal', id: 't1' }, tab('b'), tab('c'), { kind: 'terminal', id: 't2' }, tab('d')]
  const dirty = (t: FileTab): boolean => t.id === 'c'

  it('só abas de arquivo entram, terminais ficam', () => {
    expect(fileTabsToClose(list, 'b', 'others', dirty)).toEqual(['a', 'c', 'd'])
    expect(fileTabsToClose(list, 'b', 'right', dirty)).toEqual(['c', 'd'])
    expect(fileTabsToClose(list, 'b', 'saved', dirty)).toEqual(['a', 'b', 'd'])
    expect(fileTabsToClose(list, 'b', 'all', dirty)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('changeMayRemove', () => {
  const change = (files: string[], extra: Partial<FilesChange> = {}): FilesChange => ({
    dirs: [],
    files,
    allFiles: false,
    git: false,
    ignoreRules: false,
    rescan: false,
    ...extra
  })

  it('pasta apagada alcança o arquivo de dentro, com qualquer barra e caixa', () => {
    expect(changeMayRemove(change(['src']), 'src/app.ts')).toBe(true)
    expect(changeMayRemove(change(['SRC\\App.ts']), 'src/app.ts')).toBe(true)
    expect(changeMayRemove(change(['src2']), 'src\\app.ts')).toBe(false)
    expect(changeMayRemove(change(['src']), 'src2\\app.ts')).toBe(false)
    expect(changeMayRemove(change(['src\\app.tsx']), 'src\\app.ts')).toBe(false)
    expect(changeMayRemove(change([], { rescan: true }), 'src\\app.ts')).toBe(true)
  })
})

describe('comparação de arquivos', () => {
  it('título com os dois nomes; nomes iguais ganham a pasta de cada lado', () => {
    expect(compareTitle('src\\a.ts', 'lib\\b.ts')).toBe('a.ts ↔ b.ts')
    expect(compareTitle('src\\index.ts', 'lib\\INDEX.ts')).toBe('src\\index.ts ↔ lib\\INDEX.ts')
    expect(compareTitle('index.ts', 'src\\index.ts')).toBe('index.ts ↔ src\\index.ts')
    expect(compareTitle('a\\x\\index.ts', 'b\\x\\index.ts')).toBe('a\\x\\index.ts ↔ b\\x\\index.ts')
  })

  it('a mesma dupla volta para a mesma aba; invertida é outra; abrir o arquivo da direita não cai na comparação', () => {
    const first = placeCompareTab<Any>([], { projectId: 'p', left: 'a.ts', right: 'b.ts' })
    const again = placeCompareTab(first.list, { projectId: 'p', left: 'a.ts', right: 'b.ts' })
    expect(again.id).toBe(first.id)
    expect(again.list).toHaveLength(1)
    const swapped = placeCompareTab(first.list, { projectId: 'p', left: 'b.ts', right: 'a.ts' })
    expect(swapped.id).not.toBe(first.id)
    expect(swapped.list).toHaveLength(2)
    const plain = open(first.list as Any[], 'b.ts', false)
    expect(plain.id).not.toBe(first.id)
    expect(plain.list).toHaveLength(2)
  })
})

describe('tabShowsPathUnder', () => {
  it('comparação conta os dois lados: mover o arquivo da esquerda (ou a pasta dele) mexe na aba', () => {
    const tab = placeCompareTab([], { projectId: 'p', left: 'docs\\a.txt', right: 'b.txt' }).list[0] as FileTab
    expect(tabShowsPathUnder(tab, 'docs\\a.txt')).toBe(true)
    expect(tabShowsPathUnder(tab, 'docs')).toBe(true)
    expect(tabShowsPathUnder(tab, 'b.txt')).toBe(true)
    expect(tabShowsPathUnder(tab, 'outro.txt')).toBe(false)
  })
})

describe('moveFileTab', () => {
  const tab = (path: string, extra: Partial<FileTab> = {}): FileTab => ({
    kind: 'file', id: path, title: path.split('\\').pop()!, path, viewer: 'code', editing: true, dirty: false, ...extra
  })

  it('pasta renomeada leva os dois lados da comparação e refaz o título', () => {
    const compare = tab('src\\b.ts', { compare: { left: 'src\\a.ts' }, title: 'a.ts ↔ b.ts' })
    const moved = moveFileTab(compare, 'src', 'lib')
    expect(moved).toMatchObject({ path: 'lib\\b.ts', compare: { left: 'lib\\a.ts' }, title: 'a.ts ↔ b.ts' })
    const leftOnly = moveFileTab(compare, 'src\\a.ts', 'src\\z.ts')
    expect(leftOnly).toMatchObject({ path: 'src\\b.ts', compare: { left: 'src\\z.ts' }, title: 'z.ts ↔ b.ts' })
  })

  it('fora do caminho movido a aba fica igual; prefixo de nome não conta', () => {
    const t = tab('src2\\a.ts')
    expect(moveFileTab(t, 'src', 'lib')).toBe(t)
  })

  it('mesma extensão mantém o visualizador escolhido; outra extensão pega o dela', () => {
    const asText = tab('img\\logo.png', { viewer: 'code' })
    expect(moveFileTab(asText, 'img', 'assets').viewer).toBe('code')
    expect(moveFileTab(tab('notes.txt'), 'notes.txt', 'notes.md')).toMatchObject({ viewer: 'markdown', title: 'notes.md' })
  })
})

describe('moveRecentPaths', () => {
  it('recentes do Ctrl+P seguem o arquivo renomeado e a pasta movida, na mesma ordem; prefixo de nome não conta', () => {
    const recent = ['src\\a.ts', 'docs\\b.md', 'src\\sub\\c.ts', 'srcx\\d.ts']
    expect(moveRecentPaths(recent, 'docs\\b.md', 'docs\\novo.md')).toEqual(['src\\a.ts', 'docs\\novo.md', 'src\\sub\\c.ts', 'srcx\\d.ts'])
    expect(moveRecentPaths(recent, 'src', 'lib\\src')).toEqual(['lib\\src\\a.ts', 'docs\\b.md', 'lib\\src\\sub\\c.ts', 'srcx\\d.ts'])
  })

  it('destino que já estava na lista não se repete: fica a posição mais recente', () => {
    expect(moveRecentPaths(['a.ts', 'b.ts', 'c.ts'], 'c.ts', 'a.ts')).toEqual(['a.ts', 'b.ts'])
  })
})

describe('reabrir aba fechada', () => {
  const tab = (id: string, extra: Partial<FileTab> = {}): FileTab => ({
    kind: 'file', id, title: id, path: id, viewer: 'code', editing: true, dirty: false, ...extra
  })

  it('fechar várias e reabrir uma por uma refaz a ordem original, terminais no lugar', () => {
    const original: Any[] = [tab('a'), { kind: 'terminal', id: 't' }, tab('b'), tab('c')]
    const history = rememberClosed([], original, ['a', 'b', 'c'])
    let list: Any[] = [{ kind: 'terminal', id: 't' }]
    let rest = history
    for (let i = 0; i < 3; i++) {
      const step = reopenClosed(list, rest)!
      list = step.list as Any[]
      rest = step.history
    }
    expect(list.map((t) => t.id)).toEqual(['a', 't', 'b', 'c'])
    expect(reopenClosed(list, rest)).toBeNull()
  })

  it('volta fixa, com o visualizador que tinha e sem a marca de não salvo', () => {
    const closed = tab('logo.png', { viewer: 'code', dirty: true, preview: true, jump: { line: 3, n: 1 }, deleted: true })
    const step = reopenClosed<Any>([], rememberClosed([], [closed], [closed.id]))!
    const back = step.list[0] as FileTab
    expect(back).toMatchObject({ path: 'logo.png', viewer: 'code', dirty: false, preview: false })
    expect(back.jump).toBeUndefined()
    expect(back.deleted).toBeUndefined()
  })

  it('arquivo aberto de novo nesse meio-tempo só é selecionado, sem duplicar', () => {
    const history = rememberClosed([], [tab('a')], ['a'])
    const reopenedElsewhere = open([], 'a', false).list
    const step = reopenClosed(reopenedElsewhere, history)!
    expect(step.list).toHaveLength(1)
    expect(step.id).toBe(reopenedElsewhere[0]!.id)
    expect(step.history).toEqual([])
  })

  it('terminal fechado não entra na lista', () => {
    expect(rememberClosed([], [{ kind: 'terminal', id: 't' }, tab('a')], ['t', 'a']).map((c) => c.tab.id)).toEqual(['a'])
  })
})

describe('siblingFileTab', () => {
  const tab = (id: string): FileTab => ({ kind: 'file', id, title: id, path: id, viewer: 'code', editing: true, dirty: false })
  const list: Any[] = [tab('a'), { kind: 'terminal', id: 't' }, tab('b'), tab('c')]

  it('pula terminais e dá a volta nos dois sentidos', () => {
    expect(siblingFileTab(list, 'a', 1)).toBe('b')
    expect(siblingFileTab(list, 'c', 1)).toBe('a')
    expect(siblingFileTab(list, 'b', -1)).toBe('a')
    expect(siblingFileTab(list, 'a', -1)).toBe('c')
  })

  it('a partir de um terminal, a próxima aba de arquivo depois dele; sem outra aba de arquivo, nada', () => {
    expect(siblingFileTab(list, 't', 1)).toBe('b')
    expect(siblingFileTab(list, 't', -1)).toBe('a')
    expect(siblingFileTab([tab('a'), { kind: 'terminal', id: 't' }], 'a', 1)).toBeNull()
  })
})
