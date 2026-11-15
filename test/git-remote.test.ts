import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  GitError,
  explainGitOutput,
  friendlyGitError,
  gitCheckout,
  gitPull,
  gitPush,
  gitStashApply,
  gitStashDrop,
  gitStashFiles,
  gitStashList,
  gitStashPush,
  gitStatus,
  gitSync,
  overwrittenFiles,
  parseStashList
} from '../src/main/git'
import { GIT_ERROR_DETAIL } from '../src/shared/git-types'

const savedEnv = { ...process.env }
const tempDirs: string[] = []
let parent: string
let repo: string

beforeAll(() => {
  const isolation = mkdtempSync(join(tmpdir(), 'kora-gitr-env-'))
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

function identity(dir: string, name: string): void {
  git(dir, 'config', 'user.name', name)
  git(dir, 'config', 'user.email', `${name.toLowerCase()}@kora.local`)
  git(dir, 'config', 'commit.gpgsign', 'false')
}

const write = (rel: string, content: string, root = repo): void => writeFileSync(join(root, rel), content, 'utf8')
const read = (rel: string, root = repo): string => readFileSync(join(root, rel), 'utf8')
const commitAll = (dir: string, message: string): void => {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}
const parents = (rev = 'HEAD'): number => git(repo, 'rev-list', '--parents', '-n', '1', rev).trim().split(' ').length - 1
const subjects = (): string[] => git(repo, 'log', '--format=%s').trim().split('\n')

beforeEach(() => {
  parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-gitr-')))
  tempDirs.push(parent)
  repo = join(parent, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  identity(repo, 'Teste')
  write('a.txt', '1\n2\n3\n4\n5\n')
  write('b.txt', 'b\n')
  commitAll(repo, 'inicial')
})

describe('pull com o remoto', () => {
  let other: string

  beforeEach(() => {
    const remote = join(parent, 'remoto.git')
    git(parent, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    other = join(parent, 'colega')
    git(parent, 'clone', '-q', remote, other)
    identity(other, 'Colega')
  })

  // O colega muda r.txt e publica; aqui mudamos l.txt sem puxar: histórico divergente sem conflito.
  function diverge(conflicting = false): void {
    write(conflicting ? 'a.txt' : 'r.txt', 'do colega\n', other)
    commitAll(other, 'do colega')
    git(other, 'push', '-q')
    write(conflicting ? 'a.txt' : 'l.txt', 'meu\n')
    commitAll(repo, 'meu')
  }

  it('divergiu: sem config, não junta nada e devolve quantos à frente e atrás', async () => {
    diverge()
    const head = git(repo, 'rev-parse', 'HEAD')

    expect(await gitPull(repo)).toEqual({ status: 'diverged', ahead: 1, behind: 1, upstream: 'origin/main' })
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('escolher mesclar cria o commit de merge, mesmo com pull.ff=only na config', async () => {
    git(repo, 'config', 'pull.ff', 'only')
    diverge()
    expect((await gitPull(repo)).status).toBe('diverged')

    expect(await gitPull(repo, 'merge')).toEqual({ status: 'ok' })

    expect(parents()).toBe(2)
    expect(read('r.txt')).toBe('do colega\n')
    expect(read('l.txt')).toBe('meu\n')
  })

  it('escolher rebase deixa o histórico linear, com o commit local por cima', async () => {
    diverge()

    expect(await gitPull(repo, 'rebase')).toEqual({ status: 'ok' })

    expect(parents()).toBe(1)
    expect(subjects()).toEqual(['meu', 'do colega', 'inicial'])
  })

  it('pull.rebase configurado pelo usuário é respeitado sem perguntar', async () => {
    git(repo, 'config', 'pull.rebase', 'true')
    diverge()

    expect(await gitPull(repo)).toEqual({ status: 'ok' })
    expect(subjects()).toEqual(['meu', 'do colega', 'inicial'])
  })

  it('merge com conflito não é erro: devolve conflicts e o merge fica em andamento', async () => {
    diverge(true)

    expect(await gitPull(repo, 'merge')).toEqual({ status: 'conflicts' })

    const status = await gitStatus(repo)
    expect(status.operation?.kind).toBe('merge')
    expect(status.files).toEqual([{ path: 'a.txt', status: 'conflicted', staged: false, conflict: 'UU' }])
  })

  it('pull com merge em andamento é recusado antes de chamar o git', async () => {
    diverge(true)
    await gitPull(repo, 'merge')
    await expect(gitPull(repo, 'merge')).rejects.toThrow('Há um merge em andamento. Conclua ou aborte antes do Pull.')
  })

  const remoteHead = (): string => git(other, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0]!

  it('commit enviado e depois corrigido (amend): push não envia e oferece o forçado com o que seria substituído', async () => {
    write('l.txt', 'v1\n')
    commitAll(repo, 'meu commit')
    git(repo, 'push', '-q')
    const pushed = git(repo, 'rev-parse', 'HEAD').trim()
    write('l.txt', 'v2\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '--amend', '-m', 'meu commit corrigido')

    expect(await gitPush(repo)).toEqual({ status: 'rewritten', upstream: 'origin/main', remoteOid: pushed, lost: [{ hash: pushed, subject: 'meu commit' }] })
    expect(remoteHead()).toBe(pushed)

    expect(await gitPush(repo, { forceWithLease: pushed })).toEqual({ status: 'ok' })
    expect(remoteHead()).toBe(git(repo, 'rev-parse', 'HEAD').trim())
  })

  it('commit do colega (buscado, nunca foi desta branch) não vira push forçado: é recusado pedindo Pull', async () => {
    diverge()
    git(repo, 'fetch', '-q')
    expect(await gitStatus(repo)).toMatchObject({ ahead: 1, behind: 1 })

    const err = await gitPush(repo).then(
      (result) => result,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(GitError)
    expect((err as Error).message).toMatch(/^O remoto tem commits que você ainda não tem/)
  })

  it('o lease protege: se o colega enviou depois da última busca, o push forçado é cancelado', async () => {
    write('l.txt', 'v1\n')
    commitAll(repo, 'meu commit')
    git(repo, 'push', '-q')
    git(repo, 'reset', '-q', '--soft', 'HEAD~1')
    git(repo, 'commit', '-q', '-m', 'refeito')
    const offered = await gitPush(repo)
    expect(offered.status).toBe('rewritten')
    git(other, 'pull', '-q', '--ff-only')
    write('r.txt', 'do colega\n', other)
    commitAll(other, 'do colega')
    git(other, 'push', '-q')
    const colleague = remoteHead()

    const lease = offered.status === 'rewritten' ? offered.remoteOid : ''
    await expect(gitPush(repo, { forceWithLease: lease })).rejects.toThrow(/push forçado foi cancelado/)
    expect(remoteHead()).toBe(colleague)
  })

  it('sincronizar com o último commit desfeito não faz Pull (traria o commit de volta): pede o push forçado', async () => {
    write('l.txt', 'v1\n')
    commitAll(repo, 'vai ser desfeito')
    git(repo, 'push', '-q')
    git(repo, 'reset', '-q', '--soft', 'HEAD~1')
    const head = git(repo, 'rev-parse', 'HEAD').trim()

    expect(await gitSync(repo)).toMatchObject({ status: 'rewritten', lost: [{ subject: 'vai ser desfeito' }] })
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head)
  })

  it('sincronizar divergente para na pergunta sem enviar nada; com a escolha, puxa e envia', async () => {
    diverge()
    expect((await gitSync(repo)).status).toBe('diverged')
    expect(git(other, 'ls-remote', 'origin', 'main')).not.toContain(git(repo, 'rev-parse', 'HEAD').trim())

    expect(await gitSync(repo, 'rebase')).toEqual({ status: 'ok' })
    git(other, 'pull', '-q', '--ff-only')
    expect(read('l.txt', other)).toBe('meu\n')
  })

  it('rebase com alteração não commitada explica em português, com o git em Detalhes', async () => {
    diverge()
    write('b.txt', 'sujo\n')

    const err = await gitPull(repo, 'rebase').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GitError)
    const [first, detail] = (err as Error).message.split(GIT_ERROR_DETAIL)
    expect(first).toBe('O rebase precisa da árvore de trabalho limpa. Commite ou guarde as alterações no stash e tente de novo.')
    expect(detail).toMatch(/cannot pull with rebase/i)
  })
})

describe('trocar de branch com alterações locais', () => {
  beforeEach(() => {
    git(repo, 'switch', '-q', '-c', 'outra')
    write('a.txt', '1 da outra\n2\n3\n4\n5\n')
    write('novo.txt', 'rastreado na outra\n')
    commitAll(repo, 'na outra')
    git(repo, 'switch', '-q', 'main')
  })

  it('sem modo, devolve os arquivos que barram a troca e não troca nem mexe neles', async () => {
    write('a.txt', '1\n2\n3\n4\n5 local\n')

    expect(await gitCheckout(repo, 'outra')).toEqual({ status: 'local-changes', files: ['a.txt'] })
    expect((await gitStatus(repo)).branch).toBe('main')
    expect(read('a.txt')).toBe('1\n2\n3\n4\n5 local\n')
  })

  it('não rastreado que seria sobrescrito também barra a troca', async () => {
    write('novo.txt', 'meu, não rastreado\n')
    expect(await gitCheckout(repo, 'outra')).toEqual({ status: 'local-changes', files: ['novo.txt'] })
  })

  it('stash e trocar: guarda tudo (inclusive não rastreado) e troca', async () => {
    write('a.txt', '1\n2\n3\n4\n5 local\n')
    write('novo.txt', 'meu, não rastreado\n')

    expect(await gitCheckout(repo, 'outra', null, 'stash')).toEqual({ status: 'ok' })

    expect((await gitStatus(repo)).branch).toBe('outra')
    expect(read('a.txt')).toBe('1 da outra\n2\n3\n4\n5\n')
    const [stash] = await gitStashList(repo)
    expect(stash).toMatchObject({ index: 0, branch: 'main', message: 'Kora: antes de trocar para outra' })
    expect((await gitStashFiles(repo, stash!)).map((f) => f.path).sort()).toEqual(['a.txt', 'novo.txt'])
  })

  it('levar as alterações: troca e reaplica; o stash some quando aplica sem conflito', async () => {
    write('a.txt', '1\n2\n3\n4\n5 local\n')

    expect(await gitCheckout(repo, 'outra', null, 'migrate')).toEqual({ status: 'ok' })

    expect((await gitStatus(repo)).branch).toBe('outra')
    expect(read('a.txt')).toBe('1 da outra\n2\n3\n4\n5 local\n')
    expect(await gitStashList(repo)).toEqual([])
  })

  it('levar as alterações com conflito: devolve conflicts e o stash continua guardado', async () => {
    write('a.txt', '1 local\n2\n3\n4\n5\n')

    expect(await gitCheckout(repo, 'outra', null, 'migrate')).toEqual({ status: 'conflicts' })

    const status = await gitStatus(repo)
    expect(status.branch).toBe('outra')
    expect(status.files.find((f) => f.path === 'a.txt')?.status).toBe('conflicted')
    expect(await gitStashList(repo)).toHaveLength(1)
  })

  it('levar sem nada guardado não reaplica um stash antigo que não é desta troca', async () => {
    write('b.txt', 'stash antigo\n')
    git(repo, 'stash', 'push', '-q', '-m', 'antigo')

    expect(await gitCheckout(repo, 'outra', null, 'migrate')).toEqual({ status: 'ok' })

    expect(read('b.txt')).toBe('b\n')
    expect((await gitStashList(repo)).map((s) => s.message)).toEqual(['antigo'])
  })

  it('forçar descarta a alteração local e troca', async () => {
    write('a.txt', '1\n2\n3\n4\n5 local\n')

    expect(await gitCheckout(repo, 'outra', null, 'force')).toEqual({ status: 'ok' })

    expect((await gitStatus(repo)).branch).toBe('outra')
    expect(read('a.txt')).toBe('1 da outra\n2\n3\n4\n5\n')
  })

  it('branch inexistente continua erro, em português e com o git em Detalhes', async () => {
    const err = (await gitCheckout(repo, 'nao-existe').catch((e: unknown) => e)) as Error
    const [first, detail] = err.message.split(GIT_ERROR_DETAIL)
    expect(first).toBe('Não foi possível trocar para "nao-existe".')
    expect(detail).toMatch(/nao-existe/)
  })
})

describe('stash', () => {
  it('guarda com mensagem, lista, aplica (fica) e aplica e remove (sai)', async () => {
    write('a.txt', 'mudei\n')

    await gitStashPush(repo, 'meu trabalho', false)

    expect(read('a.txt')).toBe('1\n2\n3\n4\n5\n')
    const [stash] = await gitStashList(repo)
    expect(stash).toMatchObject({ index: 0, message: 'meu trabalho', branch: 'main', relative: 'agora' })

    expect(await gitStashApply(repo, stash!, false)).toBe('ok')
    expect(read('a.txt')).toBe('mudei\n')
    expect(await gitStashList(repo)).toHaveLength(1)

    git(repo, 'checkout', '--', 'a.txt')
    expect(await gitStashApply(repo, stash!, true)).toBe('ok')
    expect(read('a.txt')).toBe('mudei\n')
    expect(await gitStashList(repo)).toEqual([])
  })

  it('não rastreado só entra com includeUntracked; sem nada para guardar explica', async () => {
    write('solto.txt', 'novo\n')

    await expect(gitStashPush(repo, '', false)).rejects.toThrow(/Incluir não rastreados/)
    expect(await gitStashList(repo)).toEqual([])

    await gitStashPush(repo, '', true)
    expect(existsSync(join(repo, 'solto.txt'))).toBe(false)
    const [stash] = await gitStashList(repo)
    expect(await gitStashFiles(repo, stash!)).toEqual([{ status: 'A', path: 'solto.txt' }])

    await expect(gitStashPush(repo, '', true)).rejects.toThrow('Não há alterações para guardar no stash.')
  })

  it('remover tira só o stash pedido', async () => {
    write('a.txt', 'primeiro\n')
    await gitStashPush(repo, 'primeiro', false)
    write('a.txt', 'segundo\n')
    await gitStashPush(repo, 'segundo', false)
    const list = await gitStashList(repo)
    expect(list.map((s) => s.message)).toEqual(['segundo', 'primeiro'])

    await gitStashDrop(repo, list[1]!)

    expect((await gitStashList(repo)).map((s) => s.message)).toEqual(['segundo'])
  })

  it('stash que mudou de posição (outro programa guardou um) é recusado em vez de aplicar o errado', async () => {
    write('a.txt', 'meu\n')
    await gitStashPush(repo, 'meu', false)
    const [mine] = await gitStashList(repo)
    write('b.txt', 'do agente\n')
    git(repo, 'stash', 'push', '-q', '-m', 'do agente')

    await expect(gitStashDrop(repo, mine!)).rejects.toThrow('A lista de stash mudou')
    await expect(gitStashApply(repo, mine!, true)).rejects.toThrow('A lista de stash mudou')
    expect(await gitStashList(repo)).toHaveLength(2)
  })

  it('aplicar com conflito devolve conflicts e o pop não perde o stash', async () => {
    write('a.txt', 'guardado\n')
    await gitStashPush(repo, 'x', false)
    write('a.txt', 'commitado depois\n')
    commitAll(repo, 'depois')
    const [stash] = await gitStashList(repo)

    expect(await gitStashApply(repo, stash!, true)).toBe('conflicts')

    expect((await gitStatus(repo)).files).toEqual([{ path: 'a.txt', status: 'conflicted', staged: false, conflict: 'UU' }])
    expect(await gitStashList(repo)).toHaveLength(1)
  })

  it('parse da lista: WIP sem mensagem, mensagem com ":" e HEAD destacado', () => {
    const oid = 'a'.repeat(40)
    const output = [
      `${oid}\x1fstash@{0}\x1fOn main: corrige: detalhe\x1f1000`,
      `${oid}\x1fstash@{1}\x1fWIP on feat/x: 1234567 assunto\x1f1000`,
      `${oid}\x1fstash@{2}\x1fOn (no branch): solto\x1f1000`,
      ''
    ].join('\0')

    expect(parseStashList(output, 1000_000)).toEqual([
      { index: 0, oid, message: 'corrige: detalhe', branch: 'main', relative: 'agora' },
      { index: 1, oid, message: '1234567 assunto', branch: 'feat/x', relative: 'agora' },
      { index: 2, oid, message: 'solto', branch: null, relative: 'agora' }
    ])
  })
})

describe('mensagens do git em português', () => {
  const cases: [string, string][] = [
    ["hint: Diverging branches can't be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.", 'divergiram'],
    ['fatal: Need to specify how to reconcile divergent branches.', 'divergiram'],
    ['error: Pulling is not possible because you have unmerged files.\nhint: Fix them up in the work tree', 'Há um merge em andamento'],
    ['error: you need to resolve your current index first\na.txt: needs merge', 'Há arquivos em conflito'],
    ['error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.', 'Trocar de branch'],
    ['error: Your local changes to the following files would be overwritten by merge:\n\ta.txt', 'sobrescreveria alterações locais'],
    [' ! [rejected]        main -> main (fetch first)', 'Faça Pull'],
    ["fatal: Authentication failed for 'https://github.com/x/y.git/'", 'autenticar'],
    ["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", 'conexão'],
    ['There is no tracking information for the current branch.', 'Publique com Push'],
    ["fatal: Unable to create 'C:/r/.git/index.lock': File exists.\nAnother git process seems to be running", 'Outro processo do git'],
    ["fatal: 'outra' is already used by worktree at 'C:/w'", 'outra worktree'],
    ['CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.', 'trouxe conflitos']
  ]

  it.each(cases)('%s', (output, expected) => {
    expect(explainGitOutput(output)).toContain(expected)
  })

  it('saída desconhecida: a primeira linha é a ação em português e o texto do git vai para Detalhes', () => {
    const err = friendlyGitError(new GitError('fatal: something odd', 128, 'fatal: something odd\n'), 'O Push falhou')
    expect(err.message).toBe(`O Push falhou.${GIT_ERROR_DETAIL}fatal: something odd`)
  })

  it('erro do próprio Kora (sem código de saída) passa intacto; já traduzido não é traduzido de novo', () => {
    const own = new GitError('Nenhum arquivo informado.', null, '')
    expect(friendlyGitError(own, 'Ação')).toBe(own)
    const once = friendlyGitError(new GitError('fatal: x', 1, 'fatal: x'), 'Primeira')
    expect(friendlyGitError(once, 'Segunda').message).toBe(once.message)
  })

  it('lista de arquivos que barram a troca, como o git imprime', () => {
    const output =
      'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n\tpasta/b c.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n'
    expect(overwrittenFiles(output)).toEqual(['a.txt', 'pasta/b c.txt'])
  })
})
