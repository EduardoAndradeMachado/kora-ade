import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'

// A config global/de sistema do dono (gpgsign, hooks, autocrlf, defaultBranch) não pode mudar o resultado.
export function isolateGitConfig(): void {
  const savedEnv = { ...process.env }
  let isolation = ''
  beforeAll(() => {
    isolation = mkdtempSync(join(tmpdir(), 'kora-git-env-'))
    const emptyConfig = join(isolation, 'gitconfig')
    writeFileSync(emptyConfig, '', 'utf8')
    process.env.GIT_CONFIG_GLOBAL = emptyConfig
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_CEILING_DIRECTORIES = tmpdir()
  })
  afterAll(() => {
    rmSync(isolation, { recursive: true, force: true })
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES']) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

// Bytes crus (ex.: conteúdo do index com CRLF ou latin1), sem decodificar.
export function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function write(root: string, rel: string, content: string | Buffer): void {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

export function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Teste Kora')
  git(dir, 'config', 'user.email', 'teste@kora.local')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

export function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

export function tempRoot(tracked: string[]): string {
  // .native devolve o caminho longo (sem RUNNER~1), o mesmo formato que o git imprime.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-git-')))
  tracked.push(dir)
  return dir
}
