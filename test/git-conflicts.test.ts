import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { gitAbortOperation, gitCommit, gitContinueOperation, gitResolve, gitStatus, hasConflictMarkers } from '../src/main/git'

const savedEnv = { ...process.env }
const tempDirs: string[] = []
let repo: string

// A config global/de sistema do dono (gpgsign, conflictStyle, autocrlf, defaultBranch) não pode mudar o resultado.
beforeAll(() => {
  const isolation = mkdtempSync(join(tmpdir(), 'kora-gitc-env-'))
  tempDirs.push(isolation)
  const emptyConfig = join(isolation, 'gitconfig')
  writeFileSync(emptyConfig, '', 'utf8')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CEILING_DIRECTORIES = tmpdir()
  // Editor que falha no lugar do do usuário (ex.: "code --wait"): só passa quem não depende de editor.
  process.env.GIT_EDITOR = 'false'
})

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES', 'GIT_EDITOR']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

const write = (rel: string, content: string): void => writeFileSync(join(repo, rel), content, 'utf8')
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')
const commitAll = (message: string): void => {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', message)
}
const unmerged = (): string => git(repo, 'diff', '--name-only', '--diff-filter=U').trim()

beforeEach(() => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-gitc-')))
  tempDirs.push(parent)
  repo = join(parent, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Teste Kora')
  git(repo, 'config', 'user.email', 'teste@kora.local')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write('app.ts', 'linha 1\nlinha 2\nlinha 3\n')
  write('remover.ts', 'export const x = 1\n')
  write('leia.md', 'texto\n')
  commitAll('inicial')
})

// main e feature mudam a mesma linha de app.ts; o merge de feature em main para em conflito.
function conflictingMerge(): void {
  git(repo, 'switch', '-q', '-c', 'feature')
  write('app.ts', 'linha 1\nlinha 2 da feature\nlinha 3\n')
  commitAll('feature')
  git(repo, 'switch', '-q', 'main')
  write('app.ts', 'linha 1\nlinha 2 da main\nlinha 3\n')
  commitAll('main')
  expect(() => git(repo, 'merge', 'feature')).toThrow()
}

describe('operação em andamento', () => {
  it('merge com conflito: status mostra o merge, a mensagem do git sem comentários e o tipo do conflito', async () => {
    conflictingMerge()

    const status = await gitStatus(repo)

    expect(status.operation).toEqual({ kind: 'merge', message: "Merge branch 'feature'" })
    expect(status.files).toEqual([{ path: 'app.ts', status: 'conflicted', staged: false, conflict: 'UU' }])
    // O git deixa "# Conflicts:" no MERGE_MSG; ir para o commit com --file levaria isso junto.
    expect(readFileSync(join(repo, '.git', 'MERGE_MSG'), 'utf8')).toMatch(/^# Conflicts:/m)
  })

  it('sem nada em andamento, operation é null; stashCount conta as entradas', async () => {
    expect(await gitStatus(repo)).toMatchObject({ operation: null, stashCount: 0 })
    write('app.ts', 'mudou\n')
    git(repo, 'stash', 'push', '-q')
    write('app.ts', 'mudou de novo\n')
    git(repo, 'stash', 'push', '-q')
    expect((await gitStatus(repo)).stashCount).toBe(2)
  })

  it('rebase com conflito: tipo, branch e passo; continuar depois de resolver termina o rebase', async () => {
    git(repo, 'switch', '-q', '-c', 'feature')
    write('app.ts', 'linha 1\nlinha 2 da feature\nlinha 3\n')
    commitAll('na feature')
    git(repo, 'switch', '-q', 'main')
    write('app.ts', 'linha 1\nlinha 2 da main\nlinha 3\n')
    commitAll('na main')
    git(repo, 'switch', '-q', 'feature')
    expect(() => git(repo, 'rebase', 'main')).toThrow()

    expect((await gitStatus(repo)).operation).toEqual({ kind: 'rebase', head: 'feature', step: 1, total: 1 })

    await expect(gitContinueOperation(repo, '')).rejects.toThrow('Ainda há 1 arquivo em conflito')
    write('app.ts', 'linha 1\nlinha 2 das duas\nlinha 3\n')
    expect(await gitResolve(repo, ['app.ts'])).toEqual({ status: 'resolved' })
    // Sem editor: o --continue abriria o editor da mensagem e travaria até o timeout.
    expect(await gitContinueOperation(repo, '')).toBe('done')

    const status = await gitStatus(repo)
    expect(status.operation).toBeNull()
    expect(status.branch).toBe('feature')
    expect(git(repo, 'log', '--format=%s').trim().split('\n')).toEqual(['na feature', 'na main', 'inicial'])
  })

  it('cherry-pick com conflito é detectado e continua com a mensagem original', async () => {
    git(repo, 'switch', '-q', '-c', 'outra')
    write('app.ts', 'linha 1\nlinha 2 da outra\nlinha 3\n')
    commitAll('escolhido')
    const picked = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'switch', '-q', 'main')
    write('app.ts', 'linha 1\nlinha 2 da main\nlinha 3\n')
    commitAll('na main')
    expect(() => git(repo, 'cherry-pick', picked)).toThrow()

    expect((await gitStatus(repo)).operation).toMatchObject({ kind: 'cherry-pick', message: 'escolhido' })
    write('app.ts', 'linha 1\nresolvido\nlinha 3\n')
    await gitResolve(repo, ['app.ts'])
    expect(await gitContinueOperation(repo, '')).toBe('done')
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('escolhido')
  })

  it('abortar o merge volta os arquivos ao estado anterior', async () => {
    conflictingMerge()

    await gitAbortOperation(repo)

    expect(read('app.ts')).toBe('linha 1\nlinha 2 da main\nlinha 3\n')
    expect((await gitStatus(repo)).operation).toBeNull()
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
  })

  it('abortar ou continuar sem nada em andamento explica em português', async () => {
    await expect(gitAbortOperation(repo)).rejects.toThrow('Não há merge, rebase ou cherry-pick em andamento.')
    await expect(gitContinueOperation(repo, 'x')).rejects.toThrow('Não há merge, rebase ou cherry-pick em andamento.')
  })
})

describe('marcar como resolvido', () => {
  it('recusa arquivo que ainda tem marcadores, sem mexer no index; com force aceita', async () => {
    conflictingMerge()

    expect(await gitResolve(repo, ['app.ts'])).toEqual({ status: 'has-markers', paths: ['app.ts'] })
    expect(unmerged()).toBe('app.ts')

    expect(await gitResolve(repo, ['app.ts'], { force: true })).toEqual({ status: 'resolved' })
    expect(unmerged()).toBe('')
  })

  it('sem marcadores, coloca na fila e o merge conclui com a mensagem dada, com dois pais', async () => {
    conflictingMerge()
    write('app.ts', 'linha 1\nlinha 2 das duas\nlinha 3\n')

    expect(await gitResolve(repo, ['app.ts'])).toEqual({ status: 'resolved' })
    expect(await gitContinueOperation(repo, "Merge branch 'feature'\n\ncom ajuste")).toBe('done')

    expect(git(repo, 'log', '-1', '--format=%B').trim()).toBe("Merge branch 'feature'\n\ncom ajuste")
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
    expect((await gitStatus(repo)).operation).toBeNull()
  })

  it('concluir sem mensagem usa a do git (sem as linhas "#")', async () => {
    conflictingMerge()
    write('app.ts', 'resolvido\n')
    await gitResolve(repo, ['app.ts'])

    await gitContinueOperation(repo, '  ')

    expect(git(repo, 'log', '-1', '--format=%B').trim()).toBe("Merge branch 'feature'")
  })

  it('linha "=======" sozinha (sublinhado de título no Markdown) não é marcador', async () => {
    git(repo, 'switch', '-q', '-c', 'feature')
    write('leia.md', 'Título da feature\n=======\n')
    commitAll('md feature')
    git(repo, 'switch', '-q', 'main')
    write('leia.md', 'Título da main\n=======\n')
    commitAll('md main')
    expect(() => git(repo, 'merge', 'feature')).toThrow()
    write('leia.md', 'Título\n=======\n')

    expect(await gitResolve(repo, ['leia.md'])).toEqual({ status: 'resolved' })
  })

  it('commit pela caixa durante o merge grava o merge mesmo com a resolução igual ao HEAD', async () => {
    conflictingMerge()
    write('app.ts', 'linha 1\nlinha 2 da main\nlinha 3\n')
    await gitResolve(repo, ['app.ts'])

    expect(await gitCommit(repo, 'merge ficando com a main', false)).toBe('committed')
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
  })

  it('excluído por nós e modificado por eles (DU) exige escolha: manter a versão deles ou excluir', async () => {
    git(repo, 'switch', '-q', '-c', 'feature')
    write('remover.ts', 'export const x = 2\n')
    commitAll('muda remover')
    git(repo, 'switch', '-q', 'main')
    git(repo, 'rm', '-q', 'remover.ts')
    commitAll('apaga remover')
    expect(() => git(repo, 'merge', 'feature')).toThrow()
    expect((await gitStatus(repo)).files).toEqual([{ path: 'remover.ts', status: 'conflicted', staged: false, conflict: 'DU' }])

    expect(await gitResolve(repo, ['remover.ts'])).toEqual({ status: 'needs-choice', path: 'remover.ts', conflict: 'DU' })
    expect(unmerged()).toBe('remover.ts')

    expect(await gitResolve(repo, ['remover.ts'], { deletion: 'keep' })).toEqual({ status: 'resolved' })
    expect(git(repo, 'show', ':remover.ts')).toBe('export const x = 2\n')
  })

  it('DU com "excluir arquivo" tira do index e do disco', async () => {
    git(repo, 'switch', '-q', '-c', 'feature')
    write('remover.ts', 'export const x = 2\n')
    commitAll('muda remover')
    git(repo, 'switch', '-q', 'main')
    git(repo, 'rm', '-q', 'remover.ts')
    commitAll('apaga remover')
    expect(() => git(repo, 'merge', 'feature')).toThrow()

    expect(await gitResolve(repo, ['remover.ts'], { deletion: 'delete' })).toEqual({ status: 'resolved' })

    expect(unmerged()).toBe('')
    expect(existsSync(join(repo, 'remover.ts'))).toBe(false)
    expect(git(repo, 'ls-files', 'remover.ts').trim()).toBe('')
  })

  it('recusa caminho fora do projeto', async () => {
    conflictingMerge()
    await expect(gitResolve(repo, ['..\\fora.txt'])).rejects.toThrow()
    expect(unmerged()).toBe('app.ts')
  })
})

describe('hasConflictMarkers', () => {
  it('início ou fim de bloco no começo da linha contam; meio de linha e "=======" sozinho não', () => {
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n')).toBe(true)
    expect(hasConflictMarkers('a\r\n>>>>>>> feature\r\n')).toBe(true)
    expect(hasConflictMarkers('a\n<<<<<<<\n')).toBe(true)
    expect(hasConflictMarkers('const s = "<<<<<<< HEAD"\n')).toBe(false)
    expect(hasConflictMarkers('Título\n=======\n')).toBe(false)
    expect(hasConflictMarkers('<<<<<<<<<< oito\n')).toBe(false)
  })
})
