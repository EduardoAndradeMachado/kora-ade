import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  gitBranches,
  gitCheckout,
  gitCreateBranch,
  gitIgnored,
  gitInit,
  gitRemoteUrl,
  gitSetRemote,
  gitStatus,
  gitWorktrees,
  normalizeRemoteUrl,
  parsePorcelainV2,
  parseWorktreePorcelain,
  relativeTime
} from '../src/main/git'
import type { GitFile } from '../src/shared/git-types'

const savedEnv = { ...process.env }
const tempDirs: string[] = []
let parent: string
let repo: string

// A config global/de sistema do dono (gpgsign, hooks, autocrlf, defaultBranch) não pode mudar o resultado.
beforeAll(() => {
  const isolation = mkdtempSync(join(tmpdir(), 'kora-git-env-'))
  tempDirs.push(isolation)
  const emptyConfig = join(isolation, 'gitconfig')
  writeFileSync(emptyConfig, '', 'utf8')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CEILING_DIRECTORIES = tmpdir()
})

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(rel: string, content: string, root = repo): void {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Teste Kora')
  git(dir, 'config', 'user.email', 'teste@kora.local')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

const byPath = (a: GitFile, b: GitFile): number =>
  a.path.localeCompare(b.path) || Number(b.staged) - Number(a.staged)

beforeEach(() => {
  // .native devolve o caminho longo (sem RUNNER~1), o mesmo formato que o git imprime.
  parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-git-')))
  tempDirs.push(parent)
  repo = join(parent, 'repo')
  initRepo(repo)
  write('a.txt', 'a\n')
  write('b.txt', 'b\n')
  write('c.txt', 'c\n')
  write('dupla.txt', 'v1\n')
  write('1 velho.txt', 'conteúdo que sobrevive ao rename\n')
  write('ação com espaço.txt', 'x\n')
  write(join('pasta', 'd.txt'), 'd\n')
  commitAll(repo, 'inicial')
})

describe('git status', () => {
  it('classifica cada arquivo e separa staged de não staged', async () => {
    write('a.txt', 'a alterado\n')
    write('b.txt', 'b alterado\n')
    git(repo, 'add', 'b.txt')
    unlinkSync(join(repo, 'c.txt'))
    write('dupla.txt', 'v2\n')
    git(repo, 'add', 'dupla.txt')
    write('dupla.txt', 'v3\n')
    git(repo, 'mv', '1 velho.txt', 'novo.txt')
    write('adicionado.txt', 'novo\n')
    git(repo, 'add', 'adicionado.txt')
    write('ação com espaço.txt', 'y\n')
    write(join('pasta', 'solto.txt'), 'solto\n')

    const status = await gitStatus(repo)

    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.detached).toBe(false)
    expect([...status.files].sort(byPath)).toEqual(
      ([
        { path: 'a.txt', status: 'modified', staged: false },
        { path: 'ação com espaço.txt', status: 'modified', staged: false },
        { path: 'adicionado.txt', status: 'added', staged: true },
        { path: 'b.txt', status: 'modified', staged: true },
        { path: 'c.txt', status: 'deleted', staged: false },
        { path: 'dupla.txt', status: 'modified', staged: true },
        { path: 'dupla.txt', status: 'modified', staged: false },
        { path: 'novo.txt', status: 'renamed', staged: true, origPath: '1 velho.txt' },
        { path: join('pasta', 'solto.txt'), status: 'untracked', staged: false }
      ] satisfies GitFile[]).sort(byPath)
    )
  })

  it('projeto numa subpasta do repositório só vê os próprios arquivos, com caminho relativo a ele', async () => {
    write('a.txt', 'fora do projeto\n')
    write(join('pasta', 'd.txt'), 'dentro\n')
    write(join('pasta', 'sub', 'novo.txt'), 'novo\n')

    const status = await gitStatus(join(repo, 'pasta'))

    expect(status.files.sort(byPath)).toEqual([
      { path: 'd.txt', status: 'modified', staged: false },
      { path: join('sub', 'novo.txt'), status: 'untracked', staged: false }
    ])
  })

  it('não reescreve o index enquanto outro processo pode estar commitando', async () => {
    const index = join(repo, '.git', 'index')
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(repo, 'a.txt'), new Date(), new Date(Date.now() + 60_000))
    utimesSync(index, past, past)

    await gitStatus(repo)

    expect(statSync(index).mtimeMs).toBe(past.getTime())
  })

  it('repositório limpo não lista arquivos', async () => {
    expect((await gitStatus(repo)).files).toEqual([])
  })

  it('pasta que não é repositório devolve isRepo false sem lançar', async () => {
    const plain = join(parent, 'sem-git')
    mkdirSync(plain)
    writeFileSync(join(plain, 'x.txt'), 'x', 'utf8')

    const status = await gitStatus(plain)

    expect(status).toMatchObject({ isRepo: false, branch: null, files: [] })
    expect(await gitBranches(plain)).toEqual([])
    expect(await gitIgnored(plain, ['x.txt'])).toEqual(new Set())
  })

  it('HEAD destacado não tem branch e expõe o commit', async () => {
    const oid = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'checkout', '-q', '--detach')

    const status = await gitStatus(repo)

    expect(status).toMatchObject({ detached: true, branch: null, oid })
  })

  it('conta commits à frente e atrás do upstream', async () => {
    const remote = join(parent, 'remoto.git')
    git(parent, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')

    const other = join(parent, 'outro')
    git(parent, 'clone', '-q', remote, other)
    git(other, 'config', 'user.name', 'Outro')
    git(other, 'config', 'user.email', 'outro@kora.local')
    git(other, 'config', 'commit.gpgsign', 'false')
    write('remoto.txt', 'r\n', other)
    commitAll(other, 'commit remoto')
    git(other, 'push', '-q', 'origin', 'main')

    write('local1.txt', '1\n')
    commitAll(repo, 'local 1')
    write('local2.txt', '2\n')
    commitAll(repo, 'local 2')
    git(repo, 'fetch', '-q', 'origin')

    const status = await gitStatus(repo)

    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
  })
})

describe('parsePorcelainV2', () => {
  it('consome o caminho de origem do rename mesmo quando ele parece outro registro', () => {
    const output = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head (detached)',
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 docs/novo nome.md',
      '? falso.txt',
      '1 MM N... 100644 100644 100644 aaaa bbbb src/x.ts',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflito.ts',
      '? solto.txt',
      ''
    ].join('\0')

    const status = parsePorcelainV2(output)

    expect(status).toMatchObject({ detached: true, branch: null, oid: '0123456789abcdef0123456789abcdef01234567' })
    expect(status.files).toEqual([
      { path: join('docs', 'novo nome.md'), status: 'renamed', staged: true, origPath: '? falso.txt' },
      { path: join('src', 'x.ts'), status: 'modified', staged: true },
      { path: join('src', 'x.ts'), status: 'modified', staged: false },
      { path: 'conflito.ts', status: 'conflicted', staged: false },
      { path: 'solto.txt', status: 'untracked', staged: false }
    ])
  })
})

describe('branches', () => {
  it('lista branches locais e marca a atual', async () => {
    await gitCreateBranch(repo, 'feature/x', false)

    const branches = await gitBranches(repo)

    const lastCommit = { subject: 'inicial', relative: 'agora' }
    expect(branches).toEqual([
      { name: 'feature/x', remote: null, current: false, upstream: null, ahead: 0, behind: 0, lastCommit },
      { name: 'main', remote: null, current: true, upstream: null, ahead: 0, behind: 0, lastCommit }
    ])
  })

  it('cria e já troca para a branch nova', async () => {
    await gitCreateBranch(repo, 'feat/painel-git', true)

    expect((await gitStatus(repo)).branch).toBe('feat/painel-git')
  })

  it('troca de branch', async () => {
    await gitCreateBranch(repo, 'outra', false)
    await gitCheckout(repo, 'outra')

    expect((await gitStatus(repo)).branch).toBe('outra')
    expect((await gitBranches(repo)).find((b) => b.current)?.name).toBe('outra')
  })

  it('recusa nome inválido de branch sem criar nada', async () => {
    for (const name of ['a..b', 'com espaço', '', 'fim.lock', '--edit-description']) {
      await expect(gitCreateBranch(repo, name, false), name).rejects.toThrow(/Nome de branch inválido/)
    }
    expect((await gitBranches(repo)).map((b) => b.name)).toEqual(['main'])
  })

  it('não deixa atalho ou opção se passar por nome de branch no checkout', async () => {
    await gitCreateBranch(repo, 'anterior', true)
    await gitCheckout(repo, 'main')

    for (const name of ['-', '@{-1}']) {
      await expect(gitCheckout(repo, name), name).rejects.toThrow(/Nome de branch inválido/)
      expect((await gitStatus(repo)).branch).toBe('main')
    }
  })

  it('checkout de branch inexistente lança erro legível', async () => {
    await expect(gitCheckout(repo, 'nao-existe')).rejects.toThrow(/Não foi possível trocar para "nao-existe"/)
  })
})

describe('relativeTime', () => {
  it('descreve a idade do último commit em português', () => {
    const now = 1_700_000_000_000
    expect(relativeTime(now / 1000 - 30, now)).toBe('agora')
    expect(relativeTime(now / 1000 - 3 * 3600, now)).toBe('há 3 horas')
    expect(relativeTime(now / 1000 - 20 * 86_400, now)).toBe('há 3 semanas')
  })
})

describe('branches remotas', () => {
  // Remoto bare com `main` e `so-remota` (que nunca existiu como local neste repo).
  beforeEach(() => {
    const remote = join(parent, 'remoto.git')
    git(parent, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    git(repo, 'push', '-q', 'origin', 'main:so-remota')
    git(repo, 'fetch', '-q', 'origin')
    git(repo, 'remote', 'set-head', 'origin', 'main')
  })

  const summary = (branches: Awaited<ReturnType<typeof gitBranches>>): unknown[] =>
    branches.map(({ name, remote, current, upstream, ahead, behind }) => ({ name, remote, current, upstream, ahead, behind }))

  it('lista locais e remotas numa lista só, sem origin/HEAD, com upstream e ahead/behind', async () => {
    write('local.txt', 'l\n')
    commitAll(repo, 'commit só local')

    const branches = await gitBranches(repo)

    expect(summary(branches)).toEqual([
      { name: 'main', remote: null, current: true, upstream: 'origin/main', ahead: 1, behind: 0 },
      { name: 'origin/main', remote: 'origin', current: false, upstream: null, ahead: 0, behind: 0 },
      { name: 'origin/so-remota', remote: 'origin', current: false, upstream: null, ahead: 0, behind: 0 }
    ])
    expect(branches[0]?.lastCommit?.subject).toBe('commit só local')
  })

  it('remoto com "/" no nome é reconhecido inteiro', async () => {
    git(repo, 'remote', 'add', 'time/b', join(parent, 'remoto.git'))
    git(repo, 'fetch', '-q', 'time/b')

    const remotes = (await gitBranches(repo)).filter((b) => b.name.startsWith('time/'))

    expect(remotes.map((b) => [b.name, b.remote])).toEqual([
      ['time/b/main', 'time/b'],
      ['time/b/so-remota', 'time/b']
    ])
  })

  it('checkout de remota cria a local rastreando em vez de HEAD destacado', async () => {
    await gitCheckout(repo, 'origin/so-remota', 'origin')

    expect(await gitStatus(repo)).toMatchObject({ branch: 'so-remota', detached: false, upstream: 'origin/so-remota' })
    expect(summary(await gitBranches(repo))).toContainEqual({
      name: 'so-remota',
      remote: null,
      current: true,
      upstream: 'origin/so-remota',
      ahead: 0,
      behind: 0
    })
  })

  it('checkout de remota que já tem local rastreando só troca para ela', async () => {
    await gitCheckout(repo, 'origin/so-remota', 'origin')
    await gitCheckout(repo, 'main')

    await gitCheckout(repo, 'origin/so-remota', 'origin')

    expect((await gitStatus(repo)).branch).toBe('so-remota')
  })

  it('recusa checkout de remota quando a local de mesmo nome rastreia outra coisa', async () => {
    git(repo, 'branch', '--no-track', 'so-remota', 'main')

    await expect(gitCheckout(repo, 'origin/so-remota', 'origin')).rejects.toThrow(/Já existe uma branch local "so-remota"/)
    expect((await gitStatus(repo)).branch).toBe('main')
  })
})

describe('worktrees', () => {
  it('lista a principal e as adicionais, com marcadores', async () => {
    const extra = join(parent, 'wt ação e espaço')
    const locked = join(parent, 'wt-travada')
    const gone = join(parent, 'wt-sumida')
    const detached = join(parent, 'wt-destacada')
    git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', extra)
    git(repo, 'worktree', 'add', '-q', '-b', 'wt-travada', locked)
    git(repo, 'worktree', 'lock', '--reason', 'em uso pelo agente', locked)
    git(repo, 'worktree', 'add', '-q', '-b', 'wt-sumida', gone)
    rmSync(gone, { recursive: true, force: true })
    git(repo, 'worktree', 'add', '-q', '--detach', detached)
    const head = git(repo, 'rev-parse', 'HEAD').trim()

    const list = await gitWorktrees(repo)

    const base = { head, detached: false, bare: false, locked: false, prunable: false, current: false }
    expect(list[0]).toEqual({ ...base, path: normalize(repo), branch: 'main', current: true })
    expect(list.slice(1).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { ...base, path: normalize(extra), branch: 'wt-branch' },
      { ...base, path: normalize(detached), branch: null, detached: true },
      { ...base, path: normalize(gone), branch: 'wt-sumida', prunable: true },
      { ...base, path: normalize(locked), branch: 'wt-travada', locked: true }
    ])
  })

  it('a worktree atual é a que contém o projeto aberto', async () => {
    const extra = join(parent, 'wt ação e espaço')
    git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', extra)
    mkdirSync(join(extra, 'sub'))

    const list = await gitWorktrees(join(extra, 'sub'))

    expect(list.filter((w) => w.current).map((w) => w.path)).toEqual([normalize(extra)])
  })

  it('pasta que não é repositório não tem worktrees', async () => {
    const plain = join(parent, 'sem-git')
    mkdirSync(plain)
    expect(await gitWorktrees(plain)).toEqual([])
  })

  it('parse do porcelain -z: bare, caminho com espaço/acento, motivos de lock/prune', () => {
    const output = [
      'worktree C:/repos/central.git',
      'bare',
      '',
      'worktree C:/repos/projeto ação',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/feat/x',
      '',
      'worktree C:/repos/travada',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      'locked motivo com espaço',
      'prunable gitdir file points to non-existent location',
      '',
      ''
    ].join('\0')

    const list = parseWorktreePorcelain(output, 'C:/repos/projeto ação')

    const base = { head: '', branch: null, detached: false, bare: false, locked: false, prunable: false, current: false }
    expect(list).toEqual([
      { ...base, path: normalize('C:/repos/central.git'), bare: true },
      {
        ...base,
        path: normalize('C:/repos/projeto ação'),
        head: '1111111111111111111111111111111111111111',
        branch: 'feat/x',
        current: true
      },
      {
        ...base,
        path: normalize('C:/repos/travada'),
        head: '2222222222222222222222222222222222222222',
        detached: true,
        locked: true,
        prunable: true
      }
    ])
  })
})

describe('check-ignore', () => {
  beforeEach(() => {
    write('.gitignore', 'dist/\n*.log\nsegredo.env\n*.tmp\n')
    commitAll(repo, 'gitignore')
    write(join('pasta', 'relatório final.tmp'), 'x')
    write(join('dist', 'app.js'), 'x')
    write('debug.log', 'x')
    write(join('pasta', 'x.log'), 'x')
    write('segredo.env', 'TOKEN=1')
    write(join('src', 'index.ts'), 'x')
    write('forcado.log', 'x')
    git(repo, 'add', '-f', 'forcado.log')
  })

  it('devolve só os caminhos ignorados, no formato do explorador', async () => {
    const asked = [
      'dist',
      join('dist', 'app.js'),
      'debug.log',
      join('pasta', 'x.log'),
      'segredo.env',
      'src',
      join('src', 'index.ts'),
      '.gitignore',
      'forcado.log',
      'ação com espaço.txt',
      join('pasta', 'relatório final.tmp')
    ]

    const ignored = await gitIgnored(repo, asked)

    expect(ignored).toEqual(
      new Set([
        'dist',
        join('dist', 'app.js'),
        'debug.log',
        join('pasta', 'x.log'),
        'segredo.env',
        join('pasta', 'relatório final.tmp')
      ])
    )
  })

  it('nenhum caminho ignorado devolve conjunto vazio em vez de erro', async () => {
    expect(await gitIgnored(repo, ['src', 'a.txt', 'ação com espaço.txt'])).toEqual(new Set())
  })

  it('lista vazia não chama o git', async () => {
    expect(await gitIgnored(join(parent, 'nao-existe'), [])).toEqual(new Set())
  })
})

describe('ambiente', () => {
  it('git fora do PATH dá erro claro em português', async () => {
    const path = process.env.PATH
    process.env.PATH = join(parent, 'sem-binarios')
    try {
      await expect(gitStatus(repo)).rejects.toThrow(/Git não encontrado/)
    } finally {
      process.env.PATH = path
    }
  })
})

describe('inicializar repositório', () => {
  let plain: string
  beforeEach(() => {
    plain = join(parent, 'sem-git')
    mkdirSync(plain)
  })

  it('cria o .git e a pasta passa a ser repositório', async () => {
    await gitInit(plain)

    expect(existsSync(join(plain, '.git'))).toBe(true)
    expect((await gitStatus(plain)).isRepo).toBe(true)
  })

  it('respeita o init.defaultBranch do usuário', async () => {
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'init.defaultBranch', GIT_CONFIG_VALUE_0: 'tronco' })
    try {
      await gitInit(plain)
    } finally {
      for (const key of keys) delete process.env[key]
    }

    expect(git(plain, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/tronco')
  })

  it('recusa pasta que já é repositório, na raiz ou numa subpasta, sem criar repo aninhado', async () => {
    await expect(gitInit(repo)).rejects.toThrow(/já faz parte de um repositório git/)
    await expect(gitInit(join(repo, 'pasta'))).rejects.toThrow(/já faz parte de um repositório git/)
    expect(existsSync(join(repo, 'pasta', '.git'))).toBe(false)
  })

  it('pasta inexistente ou caminho que é arquivo dá erro claro', async () => {
    await expect(gitInit(join(parent, 'nao-existe'))).rejects.toThrow(/Pasta do projeto não existe/)
    expect(existsSync(join(parent, 'nao-existe'))).toBe(false)

    const file = join(parent, 'arquivo.txt')
    writeFileSync(file, 'x', 'utf8')
    await expect(gitInit(file)).rejects.toThrow(/Pasta do projeto não existe/)
  })
})

describe('normalizeRemoteUrl', () => {
  it('aceita as formas do GitHub e devolve a canônica', () => {
    const cases: [string, string][] = [
      ['https://github.com/dono/repo', 'https://github.com/dono/repo.git'],
      ['https://github.com/dono/repo.git', 'https://github.com/dono/repo.git'],
      ['https://github.com/dono/repo/', 'https://github.com/dono/repo.git'],
      ['git@github.com:dono/repo.git', 'git@github.com:dono/repo.git'],
      ['  https://github.com/Dono-1/meu_repo.v2  ', 'https://github.com/Dono-1/meu_repo.v2.git'],
      ['\tgit@github.com:dono/.github.git\n', 'git@github.com:dono/.github.git']
    ]
    for (const [input, expected] of cases) expect(normalizeRemoteUrl(input), input).toBe(expected)
  })

  it('recusa credenciais na URL com mensagem específica', () => {
    for (const input of ['https://u:p@github.com/a/b', 'https://ghp_token@github.com/a/b.git']) {
      expect(() => normalizeRemoteUrl(input), input).toThrow(/não pode conter usuário, senha ou token/)
    }
  })

  it('recusa tudo que não é um repositório do GitHub', () => {
    const rejected = [
      '-c core.sshCommand=calc',
      '--upload-pack=calc',
      '-https://github.com/a/b',
      'https://evil.com/a/b',
      'https://github.com.evil.com/a/b',
      'https://www.github.com/a/b',
      'http://github.com/a/b',
      'ssh://git@github.com/a/b.git',
      'git@evil.com:a/b.git',
      'file:///C:/x',
      'ext::sh -c calc',
      'C:\\repo',
      '../repo',
      'https://github.com/a',
      'https://github.com/a/b/c',
      'https://github.com/a/b?x=1',
      'https://github.com/a/b#x',
      'https://github.com:22/a/b',
      'https://github.com/a b/c',
      'https://github.com/a/b c',
      'https://github.com/a/b\n--upload-pack=calc',
      'https://github.com/ação/repo',
      'https://github.com/-a/b',
      'https://github.com/a/-b',
      'https://github.com/../b',
      'https://github.com/a/..',
      'https://github.com/a/.git',
      'git@github.com:a/-b.git',
      ''
    ]
    for (const input of rejected) expect(() => normalizeRemoteUrl(input), JSON.stringify(input)).toThrow(/URL do GitHub inválida/)
  })
})

describe('remoto origin', () => {
  const originUrl = (dir: string): string => git(dir, 'remote', 'get-url', 'origin').trim()

  it('sem origin devolve null', async () => {
    expect(await gitRemoteUrl(repo)).toBeNull()
  })

  it('pasta que não é repositório devolve null', async () => {
    const plain = join(parent, 'sem-git')
    mkdirSync(plain)
    expect(await gitRemoteUrl(plain)).toBeNull()
  })

  it('sem origin adiciona com a URL normalizada', async () => {
    const saved = await gitSetRemote(repo, ' https://github.com/dono/repo/ ')

    expect(saved).toBe('https://github.com/dono/repo.git')
    expect(originUrl(repo)).toBe('https://github.com/dono/repo.git')
    expect(await gitRemoteUrl(repo)).toBe('https://github.com/dono/repo.git')
  })

  it('com origin troca a URL em vez de falhar', async () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/antigo/repo.git')

    const saved = await gitSetRemote(repo, 'git@github.com:novo/repo.git')

    expect(saved).toBe('git@github.com:novo/repo.git')
    expect(originUrl(repo)).toBe('git@github.com:novo/repo.git')
    expect(git(repo, 'remote').trim()).toBe('origin')
  })

  it('URL recusada não altera o origin existente', async () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/antigo/repo.git')

    await expect(gitSetRemote(repo, '-c core.sshCommand=calc')).rejects.toThrow(/URL do GitHub inválida/)
    expect(originUrl(repo)).toBe('https://github.com/antigo/repo.git')
  })

  it('pasta que não é repositório dá erro claro', async () => {
    const plain = join(parent, 'sem-git')
    mkdirSync(plain)
    await expect(gitSetRemote(plain, 'https://github.com/a/b')).rejects.toThrow(/ainda não é um repositório git/)
  })
})
