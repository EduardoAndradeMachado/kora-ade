import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { gitDeleteBranch, gitPublishBranch, gitRenameBranch } from '../src/main/git-branch-actions'
import { gitAddToIgnore, ignorePattern } from '../src/main/git-ignore'
import { gitIgnored } from '../src/main/git'
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
  write(repo, 'a.txt', 'a\n')
  commitAll(repo, 'inicial')
})

const localBranches = (): string[] => git(repo, 'branch', '--format=%(refname:short)').trim().split(/\r?\n/).sort()

describe('apagar branch', () => {
  it('mesclada sai direto; não mesclada volta "not-merged" e só sai com force', async () => {
    git(repo, 'branch', 'mesclada')
    git(repo, 'switch', '-q', '-c', 'solta')
    write(repo, 'solta.txt', 'só aqui\n')
    commitAll(repo, 'commit só da solta')
    git(repo, 'switch', '-q', 'main')

    expect(await gitDeleteBranch(repo, 'mesclada', false)).toBe('deleted')
    expect(localBranches()).toEqual(['main', 'solta'])

    expect(await gitDeleteBranch(repo, 'solta', false)).toBe('not-merged')
    expect(localBranches()).toEqual(['main', 'solta'])

    expect(await gitDeleteBranch(repo, 'solta', true)).toBe('deleted')
    expect(localBranches()).toEqual(['main'])
  })

  it('recusa a branch atual, a inexistente e nome que parece opção', async () => {
    await expect(gitDeleteBranch(repo, 'main', true)).rejects.toThrow(/é a branch atual/)
    await expect(gitDeleteBranch(repo, 'nao-existe', false)).rejects.toThrow(/não existe/)
    await expect(gitDeleteBranch(repo, '-D', false)).rejects.toThrow(/Nome de branch inválido/)
    expect(localBranches()).toEqual(['main'])
  })

  it('branch aberta em outra worktree explica o motivo', async () => {
    git(repo, 'worktree', 'add', '-q', '-b', 'na-worktree', join(parent, 'wt'))
    await expect(gitDeleteBranch(repo, 'na-worktree', true)).rejects.toThrow(/aberta em outra worktree/)
    expect(localBranches()).toContain('na-worktree')
  })
})

describe('renomear branch', () => {
  it('renomeia a atual e outra; nome já usado ou inválido não muda nada', async () => {
    git(repo, 'branch', 'outra')
    await gitRenameBranch(repo, 'outra', 'feature/nova')
    expect(localBranches()).toEqual(['feature/nova', 'main'])

    await gitRenameBranch(repo, 'main', 'tronco')
    expect(git(repo, 'branch', '--show-current').trim()).toBe('tronco')

    await expect(gitRenameBranch(repo, 'tronco', 'feature/nova')).rejects.toThrow('Já existe uma branch "feature/nova".')
    await expect(gitRenameBranch(repo, 'tronco', 'nome com espaço')).rejects.toThrow(/Nome de branch inválido/)
    await expect(gitRenameBranch(repo, 'sumida', 'x')).rejects.toThrow(/não existe/)
    expect(localBranches()).toEqual(['feature/nova', 'tronco'])
  })
})

describe('publicar branch', () => {
  it('envia uma branch que não é a atual e passa a rastrear o remoto; publicada de novo é recusada', async () => {
    const remote = join(parent, 'remoto.git')
    git(parent, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'switch', '-q', '-c', 'feature')
    write(repo, 'f.txt', 'f\n')
    commitAll(repo, 'feature')
    git(repo, 'switch', '-q', 'main')

    await gitPublishBranch(repo, 'feature')

    expect(git(remote, 'log', '-1', '--format=%s', 'feature').trim()).toBe('feature')
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'feature@{upstream}').trim()).toBe('origin/feature')
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
    await expect(gitPublishBranch(repo, 'feature')).rejects.toThrow(/já está publicada em origin\/feature/)
  })

  it('sem remoto explica que falta vincular', async () => {
    git(repo, 'branch', 'feature')
    await expect(gitPublishBranch(repo, 'feature')).rejects.toThrow(/Sem repositório remoto/)
  })
})

describe('adicionar ao .gitignore', () => {
  const ignoreFile = (): string => readFileSync(join(repo, '.gitignore'), 'utf8')

  it('arquivo novo e pasta entram ancorados e passam a ser ignorados de fato; outro arquivo de mesmo nome não', async () => {
    write(repo, 'segredo.env', 'x')
    write(repo, join('build', 'saida.js'), 'x')
    write(repo, join('sub', 'segredo.env'), 'x')

    expect(gitAddToIgnore(repo, ['segredo.env', 'build'])).toEqual(['/segredo.env', '/build/'])

    expect(ignoreFile()).toBe('/segredo.env\n/build/\n')
    const ignored = await gitIgnored(repo, ['segredo.env', join('build', 'saida.js'), join('sub', 'segredo.env')])
    expect([...ignored].sort()).toEqual([join('build', 'saida.js'), 'segredo.env'].sort())
  })

  it('não duplica linha e preserva o CRLF e a falta de quebra no fim do arquivo existente', async () => {
    write(repo, '.gitignore', 'node_modules/\r\n/segredo.env  \r\n*.log')
    write(repo, 'segredo.env', 'x')
    write(repo, join('docs', 'notas [rascunho].md'), 'x')

    expect(gitAddToIgnore(repo, ['segredo.env', join('docs', 'notas [rascunho].md'), join('docs', 'notas [rascunho].md')])).toEqual([
      '/docs/notas \\[rascunho].md'
    ])
    expect(ignoreFile()).toBe('node_modules/\r\n/segredo.env  \r\n*.log\r\n/docs/notas \\[rascunho].md\r\n')
    expect([...(await gitIgnored(repo, [join('docs', 'notas [rascunho].md')]))]).toHaveLength(1)

    expect(gitAddToIgnore(repo, ['segredo.env'])).toEqual([])
    expect(ignoreFile()).toBe('node_modules/\r\n/segredo.env  \r\n*.log\r\n/docs/notas \\[rascunho].md\r\n')
  })

  it('projeto numa subpasta usa o .gitignore dela, com caminho relativo a ela', async () => {
    const project = join(repo, 'pasta')
    mkdirSync(project)
    write(project, 'gerado.txt', 'x')
    expect(gitAddToIgnore(project, ['gerado.txt'])).toEqual(['/gerado.txt'])
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('/gerado.txt\n')
    expect(existsSync(join(repo, '.gitignore'))).toBe(false)
    expect([...(await gitIgnored(project, ['gerado.txt']))]).toEqual(['gerado.txt'])
  })

  it('recusa caminho fora do projeto, a raiz e o próprio .gitignore', () => {
    expect(() => gitAddToIgnore(repo, [join('..', 'fora.txt')])).toThrow()
    expect(() => gitAddToIgnore(repo, [''])).toThrow()
    expect(() => gitAddToIgnore(repo, ['.gitignore'])).toThrow(/próprio .gitignore/)
    expect(existsSync(join(repo, '.gitignore'))).toBe(false)
  })

  it('escapa curinga, barra invertida e espaço no fim', () => {
    expect(ignorePattern('a*b?c[d]\\e', false)).toBe('/a\\*b\\?c\\[d]\\\\e')
    expect(ignorePattern('pasta/fim  ', true)).toBe('/pasta/fim\\ \\ /')
  })
})
