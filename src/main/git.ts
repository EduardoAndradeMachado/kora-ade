import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { GitBranch, GitFile, GitFileStatus, GitStatus, GitWorktree } from '../shared/git-types'

const TIMEOUT_MS = 15_000
const MAX_BUFFER = 64 * 1024 * 1024
const NOT_A_REPO = /not a git repository/i

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message)
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // O Claude/Codex e o git do usuário rodam no mesmo repo em paralelo: um `status` nosso
    // não pode pegar o index.lock e fazer o commit deles falhar.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // As mensagens de erro são comparadas por texto (ex.: "not a git repository").
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8'
  }
}

interface RunResult {
  stdout: string
  code: number
}

function runGit(root: string, args: string[], opts: { input?: string; okCodes?: number[] } = {}): Promise<RunResult> {
  const okCodes = opts.okCodes ?? [0]
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['--no-pager', '-c', 'color.ui=never', ...args],
      { cwd: root, env: gitEnv(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (!err) return resolvePromise({ stdout, code: 0 })
        if (err.code === 'ENOENT') {
          const message = existsSync(root)
            ? 'Git não encontrado. Instale o Git for Windows e garanta que o comando `git` esteja no PATH.'
            : `Pasta do projeto não existe: ${root}`
          return reject(new GitError(message, null, ''))
        }
        if (err.killed || err.signal) {
          return reject(new GitError(`O git demorou mais de ${TIMEOUT_MS / 1000}s e foi interrompido (git ${args[0]}).`, null, stderr))
        }
        const code = typeof err.code === 'number' ? err.code : null
        if (code !== null && okCodes.includes(code)) return resolvePromise({ stdout, code })
        reject(new GitError(stderr.trim() || err.message, code, stderr))
      }
    )
    // Se o git sair antes de ler o stdin (ex.: pasta que não é repo), a escrita dá EPIPE;
    // sem esse handler o erro não tratado derrubaria o processo main. O código de saída já reporta a falha.
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.input ?? '', 'utf8')
  })
}

const isNotRepo = (err: unknown): boolean =>
  err instanceof GitError && err.exitCode === 128 && NOT_A_REPO.test(err.stderr)

// O porcelain devolve caminhos relativos à raiz do repositório, que pode ser uma pasta acima do projeto.
async function repoPrefix(root: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])
    const [inside, prefix = ''] = stdout.split(/\r?\n/)
    return inside === 'true' ? prefix : null
  } catch (err) {
    if (isNotRepo(err)) return null
    throw err
  }
}

const NOT_REPO: GitStatus = {
  isRepo: false,
  branch: null,
  detached: false,
  oid: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: []
}

function statusFromCode(code: string | undefined): GitFileStatus | null {
  switch (code) {
    case 'M':
    case 'T':
      return 'modified'
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return null
  }
}

function afterFields(record: string, count: number): string {
  let idx = -1
  for (let k = 0; k < count; k++) {
    idx = record.indexOf(' ', idx + 1)
    if (idx === -1) throw new Error(`Saída inesperada do git status: ${record}`)
  }
  return record.slice(idx + 1)
}

function parseHeader(record: string, status: GitStatus): void {
  const [, key, ...rest] = record.split(' ')
  const value = rest.join(' ')
  if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value
  else if (key === 'branch.head') {
    status.detached = value === '(detached)'
    status.branch = status.detached ? null : value
  } else if (key === 'branch.upstream') status.upstream = value
  else if (key === 'branch.ab') {
    const m = /^\+(\d+) -(\d+)$/.exec(value)
    if (m) {
      status.ahead = Number(m[1])
      status.behind = Number(m[2])
    }
  }
}

// Formato: https://git-scm.com/docs/git-status#_porcelain_format_version_2 (saída de `-z`).
export function parsePorcelainV2(output: string, prefix = ''): GitStatus {
  const status: GitStatus = { ...NOT_REPO, isRepo: true, files: [] }

  const toLocal = (repoPath: string | undefined): string | undefined => {
    if (repoPath === undefined || !repoPath.startsWith(prefix)) return undefined
    return join(...repoPath.slice(prefix.length).split('/'))
  }

  const pushChanges = (xy: string, repoPath: string, repoOrig: string | undefined): void => {
    const path = toLocal(repoPath)
    if (path === undefined) return
    const sides: [string | undefined, boolean][] = [
      [xy[0], true],
      [xy[1], false]
    ]
    for (const [code, staged] of sides) {
      const fileStatus = statusFromCode(code)
      if (!fileStatus) continue
      const file: GitFile = { path, status: fileStatus, staged }
      const origPath = code === 'R' || code === 'C' ? toLocal(repoOrig) : undefined
      if (origPath !== undefined) file.origPath = origPath
      status.files.push(file)
    }
  }

  const records = output.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record === '') continue
    switch (record[0]) {
      case '#':
        parseHeader(record, status)
        break
      case '1':
        pushChanges(record.slice(2, 4), afterFields(record, 8), undefined)
        break
      case '2':
        // Em `-z` o caminho de origem do rename vem no registro seguinte, não na mesma linha.
        pushChanges(record.slice(2, 4), afterFields(record, 9), records[++i])
        break
      case 'u': {
        const path = toLocal(afterFields(record, 10))
        if (path !== undefined) status.files.push({ path, status: 'conflicted', staged: false })
        break
      }
      case '?': {
        const path = toLocal(record.slice(2))
        if (path !== undefined) status.files.push({ path, status: 'untracked', staged: false })
        break
      }
    }
  }
  return status
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const prefix = await repoPrefix(root)
  if (prefix === null) return { ...NOT_REPO, files: [] }
  const { stdout } = await runGit(root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
    '--renames',
    '--',
    '.'
  ])
  return parsePorcelainV2(stdout, prefix)
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]

export function relativeTime(unixSeconds: number, nowMs = Date.now()): string {
  const diff = unixSeconds - nowMs / 1000
  const format = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= seconds) return format.format(Math.round(diff / seconds), unit)
  }
  return 'agora'
}

// %1e (record separator) fecha cada ref: o assunto do commit é texto livre e não serve de delimitador.
const BRANCH_FORMAT =
  ['%(HEAD)', '%(refname)', '%(symref)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(subject)'].join(
    '%00'
  ) + '%1e'

// Nome de remoto pode ter "/", então "a/b/c" só se resolve contra a lista real de remotos.
function remoteOf(shortName: string, remotes: string[]): string {
  const match = remotes.filter((r) => shortName.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
  return match ?? shortName.split('/')[0]!
}

export function parseBranches(output: string, remotes: string[], nowMs = Date.now()): GitBranch[] {
  const branches: GitBranch[] = []
  for (const record of output.split('\x1e')) {
    const [head = '', ref = '', symref = '', upstream = '', track = '', unix = '', subject = ''] = record
      .replace(/^\r?\n/, '')
      .split('\0')
    if (!ref || symref) continue

    const isRemote = ref.startsWith('refs/remotes/')
    const name = ref.replace(/^refs\/(heads|remotes)\//, '')
    const branch: GitBranch = {
      name,
      remote: isRemote ? remoteOf(name, remotes) : null,
      current: head === '*',
      upstream: upstream || null,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
    }
    if (unix) branch.lastCommit = { subject, relative: relativeTime(Number(unix), nowMs) }
    branches.push(branch)
  }
  return branches
}

export async function gitBranches(root: string): Promise<GitBranch[]> {
  try {
    const [refs, remotes] = await Promise.all([
      runGit(root, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads/', 'refs/remotes/']),
      runGit(root, ['remote'])
    ])
    return parseBranches(refs.stdout, remotes.stdout.split(/\r?\n/).filter(Boolean))
  } catch (err) {
    if (isNotRepo(err)) return []
    throw err
  }
}

// `check-ref-format --branch` também expande atalhos como `@{-1}`; só aceitamos o nome se ele volta idêntico.
async function assertBranchName(root: string, name: string): Promise<void> {
  let normalized: string
  try {
    normalized = (await runGit(root, ['check-ref-format', '--branch', name])).stdout.trim()
  } catch (err) {
    if (err instanceof GitError && err.exitCode !== null) throw new GitError(`Nome de branch inválido: "${name}"`, err.exitCode, err.stderr)
    throw err
  }
  if (normalized !== name) throw new GitError(`Nome de branch inválido: "${name}"`, null, '')
}

export async function gitCreateBranch(root: string, name: string, checkout: boolean): Promise<void> {
  await assertBranchName(root, name)
  try {
    await runGit(root, checkout ? ['switch', '-c', name] : ['branch', name])
  } catch (err) {
    if (err instanceof GitError) throw new GitError(`Não foi possível criar a branch "${name}": ${err.message}`, err.exitCode, err.stderr)
    throw err
  }
}

// Branch remota nunca é trocada direto (daria HEAD destacado): vira a local de mesmo nome rastreando ela.
async function checkoutArgs(root: string, name: string, remote: string | null): Promise<string[]> {
  if (remote === null) return ['switch', name]
  if (!name.startsWith(`${remote}/`)) throw new GitError(`A branch "${name}" não pertence ao remoto "${remote}".`, null, '')
  const local = name.slice(remote.length + 1)
  await assertBranchName(root, local)

  const existing = (await gitBranches(root)).find((b) => b.remote === null && b.name === local)
  if (!existing) return ['switch', '--track', name]
  if (existing.upstream !== name) {
    throw new GitError(`Já existe uma branch local "${local}" que não rastreia "${name}".`, null, '')
  }
  return ['switch', local]
}

export async function gitCheckout(root: string, name: string, remote: string | null = null): Promise<void> {
  await assertBranchName(root, name)
  const args = await checkoutArgs(root, name, remote)
  try {
    await runGit(root, args)
  } catch (err) {
    if (err instanceof GitError) throw new GitError(`Não foi possível trocar para "${name}": ${err.message}`, err.exitCode, err.stderr)
    throw err
  }
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

// Formato: https://git-scm.com/docs/git-worktree#_porcelain_format (com `-z`, cada campo termina em NUL).
// `locked` e `prunable` podem vir seguidos de um motivo em texto livre.
export function parseWorktreePorcelain(output: string, currentTop: string | null): GitWorktree[] {
  const worktrees: GitWorktree[] = []
  let entry: GitWorktree | undefined
  for (const field of output.split('\0')) {
    const space = field.indexOf(' ')
    const key = space === -1 ? field : field.slice(0, space)
    const value = space === -1 ? '' : field.slice(space + 1)
    if (key === 'worktree') {
      const path = normalize(value)
      entry = {
        path,
        branch: null,
        head: '',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        current: currentTop !== null && samePath(path, normalize(currentTop))
      }
      worktrees.push(entry)
    } else if (!entry) continue
    else if (key === 'HEAD') entry.head = value
    else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') entry.detached = true
    else if (key === 'bare') entry.bare = true
    else if (key === 'locked') entry.locked = true
    else if (key === 'prunable') entry.prunable = true
  }
  return worktrees
}

export async function gitWorktrees(root: string): Promise<GitWorktree[]> {
  let stdout: string
  try {
    ;({ stdout } = await runGit(root, ['worktree', 'list', '--porcelain', '-z']))
  } catch (err) {
    if (isNotRepo(err)) return []
    throw err
  }
  let top: string | null = null
  try {
    top = (await runGit(root, ['rev-parse', '--show-toplevel'])).stdout.trim() || null
  } catch (err) {
    // Repositório bare não tem árvore de trabalho: nenhuma worktree é "a atual".
    if (!(err instanceof GitError) || err.exitCode === null) throw err
  }
  return parseWorktreePorcelain(stdout, top)
}

// O check-ignore ecoa cada caminho exatamente como recebeu (o Git for Windows aceita `\`),
// então a saída já casa com os `path` do explorador sem conversão.
export async function gitIgnored(root: string, relPaths: string[]): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set()
  let stdout: string
  try {
    // Exit 1 do check-ignore significa "nenhum caminho ignorado", não falha.
    ;({ stdout } = await runGit(root, ['check-ignore', '--stdin', '-z'], {
      input: relPaths.join('\0') + '\0',
      okCodes: [0, 1]
    }))
  } catch (err) {
    if (isNotRepo(err)) return new Set()
    throw err
  }
  return new Set(stdout.split('\0').filter(Boolean))
}

async function isInsideRepo(root: string): Promise<boolean> {
  try {
    await runGit(root, ['rev-parse', '--git-dir'])
    return true
  } catch (err) {
    if (isNotRepo(err)) return false
    throw err
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function gitInit(root: string): Promise<void> {
  if (!isDirectory(root)) throw new GitError(`Pasta do projeto não existe: ${root}`, null, '')
  if (await isInsideRepo(root)) {
    throw new GitError('Esta pasta já faz parte de um repositório git; não é preciso inicializar outro.', null, '')
  }
  try {
    await runGit(root, ['init'])
  } catch (err) {
    if (err instanceof GitError) throw new GitError(`Não foi possível inicializar o repositório: ${err.message}`, err.exitCode, err.stderr)
    throw err
  }
}

const GITHUB_HTTPS = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)\/?$/i
const GITHUB_SSH = /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/i
const URL_WITH_CREDENTIALS = /^https?:\/\/[^/]*@/i

const validSegment = (segment: string): boolean => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('-')

// A URL vai direto para `git remote add`: só passa o que for inequivocamente um repositório do GitHub,
// sem credenciais, sem transportes alternativos (file:, ext::) e sem nada que o git possa ler como opção.
export function normalizeRemoteUrl(input: string): string {
  if (typeof input !== 'string') throw new Error('URL do repositório inválida.')
  const url = input.trim()
  if (URL_WITH_CREDENTIALS.test(url)) {
    throw new Error('A URL não pode conter usuário, senha ou token. Use a URL do repositório sem credenciais.')
  }
  const https = GITHUB_HTTPS.exec(url)
  const ssh = https ? null : GITHUB_SSH.exec(url)
  const match = https ?? ssh
  const owner = match?.[1] ?? ''
  const repo = (match?.[2] ?? '').replace(/\.git$/i, '')
  if (!match || !validSegment(owner) || !validSegment(repo)) {
    throw new Error(
      'URL do GitHub inválida. Use https://github.com/dono/repositorio ou git@github.com:dono/repositorio.git.'
    )
  }
  return https ? `https://github.com/${owner}/${repo}.git` : `git@github.com:${owner}/${repo}.git`
}

export async function gitRemoteUrl(root: string): Promise<string | null> {
  try {
    // Exit 2 do `remote get-url` significa "remoto não existe".
    const { stdout, code } = await runGit(root, ['remote', 'get-url', 'origin'], { okCodes: [2] })
    return code === 0 ? stdout.trim() || null : null
  } catch (err) {
    if (isNotRepo(err)) return null
    throw err
  }
}

export async function gitSetRemote(root: string, input: string): Promise<string> {
  const url = normalizeRemoteUrl(input)
  try {
    const remotes = (await runGit(root, ['remote'])).stdout.split(/\r?\n/)
    const action = remotes.includes('origin') ? 'set-url' : 'add'
    await runGit(root, ['remote', action, '--', 'origin', url])
  } catch (err) {
    if (isNotRepo(err)) {
      throw new GitError('Esta pasta ainda não é um repositório git. Inicialize o repositório antes de vincular ao GitHub.', 128, (err as GitError).stderr)
    }
    if (err instanceof GitError) throw new GitError(`Não foi possível configurar o remoto "origin": ${err.message}`, err.exitCode, err.stderr)
    throw err
  }
  return url
}
