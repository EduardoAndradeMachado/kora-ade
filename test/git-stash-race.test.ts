import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { git, isolateGitConfig } from './git-test-repo'

// Um agente que guarda um stash no exato intervalo entre a conferência do oid e a ação do Kora: o gancho roda o
// `git stash push` de verdade logo antes do próximo `git status` (ou do `git stash drop`) que o Kora disparar.
const race = vi.hoisted(() => ({ before: null as null | { when: (args: string[]) => boolean; run: () => void } }))

vi.mock('node:child_process', async (load) => {
  const real = await load<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => {
      const hook = race.before
      if (hook && hook.when(args)) {
        race.before = null
        hook.run()
      }
      return (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest)
    }) as typeof real.execFile
  }
})

const { gitStashApply, gitStashDrop, gitStashList, gitStashPush } = await import('../src/main/git')

isolateGitConfig()
const dirs: string[] = []
let repo: string
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const write = (rel: string, content: string): void => writeFileSync(join(repo, rel), content, 'utf8')
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')
const agentStashes = (): void => {
  write('b.txt', 'do agente\n')
  git(repo, 'stash', 'push', '-q', '-m', 'do agente')
}

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-stash-race-')))
  dirs.push(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Teste')
  git(repo, 'config', 'user.email', 'teste@kora.local')
  git(repo, 'config', 'commit.gpgsign', 'false')
  write('a.txt', 'a\n')
  write('b.txt', 'b\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'inicial')
})

describe('stash guardado por outro programa entre a conferência e a ação', () => {
  it('aplicar e remover (pop) aplica e remove o stash pedido, e o do agente continua guardado', async () => {
    write('a.txt', 'meu\n')
    await gitStashPush(repo, 'meu', false)
    const [mine] = await gitStashList(repo)
    race.before = { when: (args) => args.includes('status'), run: agentStashes }

    expect(await gitStashApply(repo, mine!, true)).toBe('ok')

    expect(race.before).toBeNull()
    expect(read('a.txt')).toBe('meu\n')
    expect(read('b.txt')).toBe('b\n')
    expect((await gitStashList(repo)).map((s) => s.message)).toEqual(['do agente'])
  })

  it('aplicar (sem remover) aplica o stash pedido e não mexe na lista', async () => {
    write('a.txt', 'meu\n')
    await gitStashPush(repo, 'meu', false)
    const [mine] = await gitStashList(repo)
    race.before = { when: (args) => args.includes('status'), run: agentStashes }

    expect(await gitStashApply(repo, mine!, false)).toBe('ok')

    expect(read('a.txt')).toBe('meu\n')
    expect((await gitStashList(repo)).map((s) => s.message)).toEqual(['do agente', 'meu'])
  })

  it('remover não apaga o stash do agente', async () => {
    write('a.txt', 'meu\n')
    await gitStashPush(repo, 'meu', false)
    const [mine] = await gitStashList(repo)
    race.before = { when: (args) => args.includes('drop'), run: agentStashes }

    await gitStashDrop(repo, mine!)

    expect((await gitStashList(repo)).map((s) => s.message)).toEqual(['do agente'])
  })
})
