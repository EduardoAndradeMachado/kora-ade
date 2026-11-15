import { rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  gitCommitAmend,
  gitCommitDiff,
  gitCommitFiles,
  gitFileAt,
  gitHeadCommit,
  gitLog,
  gitUndoLastCommit,
  parseRefs
} from '../src/main/git-history'
import { commitAll, git, initRepo, isolateGitConfig, tempRoot, write } from './git-test-repo'

isolateGitConfig()
const tempDirs: string[] = []
let parent: string
let repo: string

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  parent = tempRoot(tempDirs)
  repo = join(parent, 'repo')
  initRepo(repo)
  write(repo, 'a.txt', 'a1\n')
  write(repo, join('pasta', 'd.txt'), 'd1\n')
  commitAll(repo, 'inicial')
})

const subjects = (page: { commits: { subject: string }[] }): string[] => page.commits.map((c) => c.subject)

describe('histórico (git log)', () => {
  it('pagina do mais novo para o mais velho e diz se há mais', async () => {
    for (let n = 2; n <= 5; n++) {
      write(repo, 'a.txt', `a${n}\n`)
      commitAll(repo, `commit ${n}`)
    }
    const first = await gitLog(repo, { limit: 2 })
    expect(subjects(first)).toEqual(['commit 5', 'commit 4'])
    expect(first.hasMore).toBe(true)

    const middle = await gitLog(repo, { skip: 2, limit: 2 })
    expect(subjects(middle)).toEqual(['commit 3', 'commit 2'])
    expect(middle.hasMore).toBe(true)

    const last = await gitLog(repo, { skip: 4, limit: 2 })
    expect(subjects(last)).toEqual(['inicial'])
    expect(last.hasMore).toBe(false)

    const exact = await gitLog(repo, { limit: 5 })
    expect(exact.commits).toHaveLength(5)
    expect(exact.hasMore).toBe(false)
  })

  it('traz autor, data, corpo, pais e refs (branch atual, tag, remota)', async () => {
    write(repo, 'a.txt', 'a2\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'feat: título com acentuação', '-m', 'corpo\n\nem várias linhas')
    git(repo, 'tag', 'v1.0')
    const remote = join(parent, 'remoto.git')
    git(parent, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    const before = git(repo, 'rev-parse', 'HEAD~1').trim()

    const [latest, initial] = (await gitLog(repo)).commits
    expect(latest).toMatchObject({
      hash: head,
      parents: [before],
      author: 'Teste Kora',
      email: 'teste@kora.local',
      subject: 'feat: título com acentuação',
      body: 'corpo\n\nem várias linhas'
    })
    expect(latest!.refs).toEqual([
      { name: 'main', kind: 'branch', current: true },
      { name: 'v1.0', kind: 'tag' },
      { name: 'origin/main', kind: 'remote' }
    ])
    expect(Math.abs(latest!.date - Date.now() / 1000)).toBeLessThan(120)
    expect(latest!.relative).toBe('agora')
    expect(initial).toMatchObject({ subject: 'inicial', parents: [], refs: [] })
  })

  it('histórico do arquivo segue a renomeação (--follow) e ignora commits de outros arquivos', async () => {
    write(repo, 'a.txt', 'a1\nmais uma linha\n')
    commitAll(repo, 'mexe em a')
    write(repo, join('pasta', 'd.txt'), 'd2\n')
    commitAll(repo, 'só em d')
    git(repo, 'mv', 'a.txt', 'renomeado.txt')
    commitAll(repo, 'renomeia a')
    write(repo, 'renomeado.txt', 'a1\nmais uma linha\nfim\n')
    commitAll(repo, 'mexe no renomeado')

    expect(subjects(await gitLog(repo, { path: 'renomeado.txt' }))).toEqual(['mexe no renomeado', 'renomeia a', 'mexe em a', 'inicial'])
    expect(subjects(await gitLog(repo, { path: join('pasta', 'd.txt') }))).toEqual(['só em d', 'inicial'])
    const paged = await gitLog(repo, { path: 'renomeado.txt', skip: 1, limit: 2 })
    expect(subjects(paged)).toEqual(['renomeia a', 'mexe em a'])
    expect(paged.hasMore).toBe(true)
  })

  it('projeto numa subpasta só vê os commits que mexem nela; o merge aparece no projeto na raiz', async () => {
    write(repo, 'a.txt', 'fora\n')
    commitAll(repo, 'fora do projeto')
    git(repo, 'switch', '-q', '-c', 'lado')
    write(repo, join('pasta', 'd.txt'), 'd do lado\n')
    commitAll(repo, 'dentro do projeto')
    git(repo, 'switch', '-q', 'main')
    write(repo, 'a.txt', 'fora 2\n')
    commitAll(repo, 'fora 2')
    git(repo, 'merge', '-q', '--no-edit', 'lado')

    expect(subjects(await gitLog(join(repo, 'pasta')))).toEqual(['dentro do projeto', 'inicial'])
    expect(subjects(await gitLog(repo))[0]).toMatch(/^Merge branch 'lado'/)
  })

  it('repositório sem commit e pasta fora de repositório devolvem lista vazia', async () => {
    const fresh = join(parent, 'fresh')
    initRepo(fresh)
    expect(await gitLog(fresh)).toEqual({ commits: [], hasMore: false })
    const plain = join(parent, 'plain')
    write(plain, 'x.txt', 'x')
    expect(await gitLog(plain)).toEqual({ commits: [], hasMore: false })
  })
})

describe('parseRefs', () => {
  it('HEAD destacado, branch local, remota, tag; origin/HEAD fica de fora', () => {
    expect(parseRefs('HEAD, refs/heads/x/y, refs/remotes/time/b/main, refs/remotes/origin/HEAD, tag: refs/tags/v2')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'x/y', kind: 'branch' },
      { name: 'time/b/main', kind: 'remote' },
      { name: 'v2', kind: 'tag' }
    ])
  })
})

describe('arquivos e diff de um commit', () => {
  it('lista modificado, adicionado, apagado e renomeado contra o primeiro pai', async () => {
    write(repo, 'grande.txt', 'linha 1\nlinha 2\nlinha 3\nlinha 4\n')
    commitAll(repo, 'grande')
    write(repo, 'a.txt', 'a2\n')
    write(repo, 'novo.txt', 'novo\n')
    unlinkSync(join(repo, 'pasta', 'd.txt'))
    git(repo, 'mv', 'grande.txt', 'movido.txt')
    commitAll(repo, 'várias')

    const files = await gitCommitFiles(repo, git(repo, 'rev-parse', 'HEAD').trim())
    expect([...files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'movido.txt', status: 'renamed', origPath: 'grande.txt' },
      { path: 'novo.txt', status: 'added' },
      { path: join('pasta', 'd.txt'), status: 'deleted' }
    ])
  })

  it('commit inicial lista tudo como adicionado; merge compara com o primeiro pai; hash curto vale', async () => {
    const root = git(repo, 'rev-parse', 'HEAD').trim()
    expect((await gitCommitFiles(repo, root.slice(0, 7))).map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'added'],
      [join('pasta', 'd.txt'), 'added']
    ])

    git(repo, 'switch', '-q', '-c', 'lado')
    write(repo, 'lado.txt', 'lado\n')
    commitAll(repo, 'lado')
    git(repo, 'switch', '-q', 'main')
    write(repo, 'a.txt', 'a no main\n')
    commitAll(repo, 'main')
    git(repo, 'merge', '-q', '--no-edit', 'lado')
    expect(await gitCommitFiles(repo, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([{ path: 'lado.txt', status: 'added' }])
  })

  it('projeto numa subpasta: caminhos relativos a ela e nada de fora', async () => {
    write(repo, 'a.txt', 'a2\n')
    write(repo, join('pasta', 'd.txt'), 'd2\n')
    commitAll(repo, 'dois')
    expect(await gitCommitFiles(join(repo, 'pasta'), git(repo, 'rev-parse', 'HEAD').trim())).toEqual([{ path: 'd.txt', status: 'modified' }])
  })

  it('diff de um arquivo no commit: pai à esquerda, commit à direita; renomeado lê o caminho antigo; inicial contra vazio', async () => {
    const root = git(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'a.txt', 'a2\n')
    commitAll(repo, 'muda a')
    const changed = git(repo, 'rev-parse', 'HEAD').trim()
    write(repo, 'a.txt', 'a3\n')
    commitAll(repo, 'muda de novo')
    git(repo, 'mv', 'a.txt', 'b.txt')
    write(repo, 'b.txt', 'a3\nb\n')
    commitAll(repo, 'renomeia')
    const renamed = git(repo, 'rev-parse', 'HEAD').trim()

    expect(await gitCommitDiff(repo, changed, 'a.txt')).toEqual({ original: 'a1\n', modified: 'a2\n', binary: false })
    expect(await gitCommitDiff(repo, renamed, 'b.txt', 'a.txt')).toEqual({ original: 'a3\n', modified: 'a3\nb\n', binary: false })
    expect(await gitCommitDiff(repo, root, 'a.txt')).toEqual({ original: '', modified: 'a1\n', binary: false })
  })

  it('hash inválido ou inexistente e caminho fora do projeto são recusados', async () => {
    await expect(gitCommitFiles(repo, '--all')).rejects.toThrow(/Commit inválido/)
    await expect(gitCommitFiles(repo, 'deadbeefdeadbeef')).rejects.toThrow(/não existe neste repositório/)
    await expect(gitCommitDiff(repo, git(repo, 'rev-parse', 'HEAD').trim(), join('..', 'fora.txt'))).rejects.toThrow()
  })

  it('arquivo no HEAD ("Abrir arquivo (HEAD)")', async () => {
    write(repo, 'a.txt', 'no disco\n')
    expect(await gitFileAt(repo, 'HEAD', 'a.txt')).toEqual({ text: 'a1\n', binary: false, exists: true })
    expect(await gitFileAt(repo, 'HEAD', 'nao-existe.txt')).toEqual({ text: '', binary: false, exists: false })
  })
})

describe('corrigir (amend) e desfazer o último commit', () => {
  const log = (): string[] => git(repo, 'log', '--format=%s').trim().split(/\r?\n/)

  it('corrigir troca a mensagem e leva o que está na fila, sem criar commit novo', async () => {
    write(repo, 'a.txt', 'a2\n')
    commitAll(repo, 'mensagem errada')
    const parentBefore = git(repo, 'rev-parse', 'HEAD~1').trim()
    write(repo, 'extra.txt', 'esqueci\n')
    git(repo, 'add', 'extra.txt')
    write(repo, 'a.txt', 'fora da fila\n')

    await gitCommitAmend(repo, 'feat: mensagem certa\n\ncom corpo')

    expect(log()).toEqual(['feat: mensagem certa', 'inicial'])
    expect(git(repo, 'log', '-1', '--format=%B').trimEnd()).toBe('feat: mensagem certa\n\ncom corpo')
    expect(git(repo, 'rev-parse', 'HEAD~1').trim()).toBe(parentBefore)
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split(/\r?\n/).sort()).toEqual(['a.txt', 'extra.txt'])
    expect(git(repo, 'show', 'HEAD:a.txt')).toBe('a2\n')
  })

  it('corrigir sem commit ou com mensagem vazia é recusado', async () => {
    await expect(gitCommitAmend(repo, '  ')).rejects.toThrow('Escreva a mensagem do commit.')
    const fresh = join(parent, 'fresh')
    initRepo(fresh)
    await expect(gitCommitAmend(fresh, 'x')).rejects.toThrow('Ainda não há commit para corrigir.')
  })

  it('último commit: mensagem, se é o primeiro e se já foi enviado', async () => {
    expect(await gitHeadCommit(repo)).toMatchObject({ message: 'inicial', isRoot: true, pushed: false })
    write(repo, 'a.txt', 'a2\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'segundo', '-m', 'corpo')
    const remote = join(parent, 'remoto.git')
    git(parent, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    expect(await gitHeadCommit(repo)).toMatchObject({ message: 'segundo\n\ncorpo', isRoot: false, pushed: false })
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    expect(await gitHeadCommit(repo)).toMatchObject({ hash: git(repo, 'rev-parse', 'HEAD').trim(), pushed: true })

    write(repo, 'a.txt', 'a3\n')
    commitAll(repo, 'local')
    expect((await gitHeadCommit(repo))?.pushed).toBe(false)

    const fresh = join(parent, 'fresh')
    initRepo(fresh)
    expect(await gitHeadCommit(fresh)).toBeNull()
  })

  it('desfazer tira o commit e deixa as alterações dele na fila, sem mexer no disco', async () => {
    write(repo, 'a.txt', 'a2\n')
    write(repo, 'novo.txt', 'novo\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'para desfazer', '-m', 'corpo')
    write(repo, 'a.txt', 'a3 no disco\n')

    expect(await gitUndoLastCommit(repo)).toEqual({ message: 'para desfazer\n\ncorpo' })

    expect(log()).toEqual(['inicial'])
    expect(git(repo, 'diff', '--cached', '--name-status').trim().split(/\r?\n/).sort()).toEqual(['A\tnovo.txt', 'M\ta.txt'])
    expect(git(repo, 'show', ':a.txt')).toBe('a2\n')
    expect(git(repo, 'show', 'HEAD:a.txt')).toBe('a1\n')
  })

  it('desfazer recusa o primeiro commit, repositório sem commit e merge em andamento', async () => {
    await expect(gitUndoLastCommit(repo)).rejects.toThrow(/primeiro commit do repositório/)
    expect(log()).toEqual(['inicial'])

    const fresh = join(parent, 'fresh')
    initRepo(fresh)
    await expect(gitUndoLastCommit(fresh)).rejects.toThrow('Ainda não há commit para desfazer.')

    git(repo, 'switch', '-q', '-c', 'lado')
    write(repo, 'a.txt', 'lado\n')
    commitAll(repo, 'lado')
    git(repo, 'switch', '-q', 'main')
    write(repo, 'a.txt', 'main\n')
    commitAll(repo, 'main')
    expect(() => git(repo, 'merge', 'lado')).toThrow()
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    await expect(gitUndoLastCommit(repo)).rejects.toThrow(/merge em andamento/)
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head)
  })
})
