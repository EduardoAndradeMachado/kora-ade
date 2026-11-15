import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { gitApplyHunk, gitHunks, parseHunks } from '../src/main/git-hunks'
import { commitAll, git, gitBytes, initRepo, isolateGitConfig, tempRoot, write } from './git-test-repo'

isolateGitConfig()
const tempDirs: string[] = []
let repo: string

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const lines = (n: number, eol = '\n'): string => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join(eol) + eol
// Troca as linhas pedidas (base 1) do texto, mantendo o fim de linha.
const edit = (text: string, changes: Record<number, string>, eol = '\n'): string =>
  text
    .split(eol)
    .map((line, i) => changes[i + 1] ?? line)
    .join(eol)

const indexText = (rel: string): string => gitBytes(repo, 'show', `:${rel}`).toString('utf8')
const diskText = (rel: string): string => readFileSync(join(repo, rel), 'utf8')

beforeEach(() => {
  repo = join(tempRoot(tempDirs), 'repo')
  initRepo(repo)
  write(repo, 'f.txt', lines(20))
  commitAll(repo, 'inicial')
})

describe('trechos do diff (-U0)', () => {
  it('cada bloco alterado é um trecho, com as linhas de cada lado', async () => {
    write(repo, 'f.txt', edit(lines(20), { 2: 'DOIS', 10: 'DEZ\nnova' }).replace('linha 18\n', ''))
    expect((await gitHunks(repo, 'f.txt', false)).map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [2, 1, 2, 1],
      [10, 1, 10, 2],
      [18, 1, 18, 0]
    ])
    expect(await gitHunks(repo, 'f.txt', true)).toEqual([])
  })

  it('parse guarda o "\\ No newline" no trecho e recusa patch de mais de um arquivo', () => {
    const one = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n'
    expect(parseHunks(one).hunks[0]!.text).toBe('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n')
    expect(parseHunks(one + one.replace(/x/g, 'y')).hunks).toEqual([])
  })
})

describe('colocar, tirar e descartar um trecho', () => {
  const threeChanges = (): string => edit(lines(20), { 2: 'DOIS', 10: 'DEZ', 18: 'DEZOITO' })

  it('colocar na fila leva só o trecho escolhido; o disco não muda', async () => {
    write(repo, 'f.txt', threeChanges())
    const hunks = await gitHunks(repo, 'f.txt', false)

    await gitApplyHunk(repo, 'f.txt', false, hunks[1]!.id, 'stage')

    expect(indexText('f.txt')).toBe(edit(lines(20), { 10: 'DEZ' }))
    expect(diskText('f.txt')).toBe(threeChanges())
    expect((await gitHunks(repo, 'f.txt', false)).map((h) => h.oldStart)).toEqual([2, 18])
  })

  it('tirar da fila devolve só o trecho escolhido para as alterações', async () => {
    write(repo, 'f.txt', threeChanges())
    git(repo, 'add', 'f.txt')
    const staged = await gitHunks(repo, 'f.txt', true)

    await gitApplyHunk(repo, 'f.txt', true, staged[0]!.id, 'unstage')

    expect(indexText('f.txt')).toBe(edit(lines(20), { 10: 'DEZ', 18: 'DEZOITO' }))
    expect(diskText('f.txt')).toBe(threeChanges())
  })

  it('descartar desfaz só o trecho no disco e não mexe na fila', async () => {
    write(repo, 'f.txt', threeChanges())
    const hunks = await gitHunks(repo, 'f.txt', false)

    await gitApplyHunk(repo, 'f.txt', false, hunks[2]!.id, 'discard')

    expect(diskText('f.txt')).toBe(edit(lines(20), { 2: 'DOIS', 10: 'DEZ' }))
    expect(indexText('f.txt')).toBe(lines(20))
  })

  it('trecho de inserção e de remoção pura, inclusive no fim do arquivo', async () => {
    write(repo, 'f.txt', edit(lines(20), { 5: 'linha 5\ninserida' }).replace('linha 20\n', ''))
    const [insert, remove] = await gitHunks(repo, 'f.txt', false)
    await gitApplyHunk(repo, 'f.txt', false, remove!.id, 'stage')
    expect(indexText('f.txt')).toBe(lines(19))
    await gitApplyHunk(repo, 'f.txt', false, insert!.id, 'stage')
    expect(indexText('f.txt')).toBe(diskText('f.txt'))
  })

  it('arquivo com CRLF no repositório: o trecho vai com o CRLF intacto', async () => {
    write(repo, 'crlf.txt', lines(12, '\r\n'))
    commitAll(repo, 'crlf')
    write(repo, 'crlf.txt', edit(lines(12, '\r\n'), { 3: 'TRÊS', 9: 'NOVE' }, '\r\n'))
    const hunks = await gitHunks(repo, 'crlf.txt', false)
    expect(hunks).toHaveLength(2)

    await gitApplyHunk(repo, 'crlf.txt', false, hunks[1]!.id, 'stage')
    expect(indexText('crlf.txt')).toBe(edit(lines(12, '\r\n'), { 9: 'NOVE' }, '\r\n'))

    await gitApplyHunk(repo, 'crlf.txt', false, (await gitHunks(repo, 'crlf.txt', false))[0]!.id, 'discard')
    expect(diskText('crlf.txt')).toBe(edit(lines(12, '\r\n'), { 9: 'NOVE' }, '\r\n'))
  })

  it('core.autocrlf=true (index LF, disco CRLF): fila em LF e descarte mantém o CRLF no disco', async () => {
    git(repo, 'config', 'core.autocrlf', 'true')
    write(repo, 'f.txt', edit(lines(20, '\r\n'), { 2: 'DOIS', 18: 'DEZOITO' }, '\r\n'))
    const hunks = await gitHunks(repo, 'f.txt', false)
    expect(hunks).toHaveLength(2)

    await gitApplyHunk(repo, 'f.txt', false, hunks[0]!.id, 'stage')
    expect(indexText('f.txt')).toBe(edit(lines(20), { 2: 'DOIS' }))

    await gitApplyHunk(repo, 'f.txt', false, (await gitHunks(repo, 'f.txt', false))[0]!.id, 'discard')
    expect(diskText('f.txt')).toBe(edit(lines(20, '\r\n'), { 2: 'DOIS' }, '\r\n'))
  })

  it('arquivo novo já na fila: trecho do disco entra sozinho; tirar o único trecho tira o arquivo da fila', async () => {
    write(repo, 'novo.txt', lines(10))
    git(repo, 'add', 'novo.txt')
    write(repo, 'novo.txt', edit(lines(10), { 1: 'UM', 9: 'NOVE' }))
    const [first] = await gitHunks(repo, 'novo.txt', false)

    await gitApplyHunk(repo, 'novo.txt', false, first!.id, 'stage')
    expect(indexText('novo.txt')).toBe(edit(lines(10), { 1: 'UM' }))

    const staged = await gitHunks(repo, 'novo.txt', true)
    expect(staged).toHaveLength(1)
    await gitApplyHunk(repo, 'novo.txt', true, staged[0]!.id, 'unstage')
    expect(git(repo, 'status', '--porcelain', '--', 'novo.txt').trim()).toBe('?? novo.txt')
  })

  it('bytes que não são UTF-8 (Windows-1252) passam intactos', async () => {
    const latin = (text: string): Buffer => Buffer.from(text, 'latin1')
    write(repo, 'latin.txt', latin('ação\nb\nc\nd\ne\nf\ng\nfim\n'))
    commitAll(repo, 'latin')
    write(repo, 'latin.txt', latin('AÇÃO\nb\nc\nd\ne\nf\ng\nfím\n'))
    const hunks = await gitHunks(repo, 'latin.txt', false)

    await gitApplyHunk(repo, 'latin.txt', false, hunks[0]!.id, 'stage')
    expect(gitBytes(repo, 'show', ':latin.txt')).toEqual(latin('AÇÃO\nb\nc\nd\ne\nf\ng\nfim\n'))
  })

  it('trecho que mudou desde o diff, ação trocada e caminho fora do projeto são recusados sem mexer em nada', async () => {
    write(repo, 'f.txt', threeChanges())
    const [first] = await gitHunks(repo, 'f.txt', false)
    write(repo, 'f.txt', edit(lines(20), { 2: 'OUTRO', 10: 'DEZ', 18: 'DEZOITO' }))

    await expect(gitApplyHunk(repo, 'f.txt', false, first!.id, 'stage')).rejects.toThrow(/O trecho mudou/)
    const [current] = await gitHunks(repo, 'f.txt', false)
    await expect(gitApplyHunk(repo, 'f.txt', false, current!.id, 'unstage')).rejects.toThrow(/inválida/)
    await expect(gitApplyHunk(repo, 'f.txt', true, current!.id, 'stage')).rejects.toThrow(/inválida/)
    await expect(gitApplyHunk(repo, join('..', 'f.txt'), false, current!.id, 'stage')).rejects.toThrow()
    expect(indexText('f.txt')).toBe(lines(20))
  })
})
