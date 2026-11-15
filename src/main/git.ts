import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, relative, resolve, sep } from 'node:path'
import type { GitBranch, GitCommitResult, GitDiff, GitFile, GitFileStatus, GitStatus, GitWorktree } from '../shared/git-types'
import {
  GIT_ERROR_DETAIL,
  type GitCheckoutMode,
  type GitCheckoutResult,
  type GitConflictCode,
  type GitContinueResult,
  type GitDeletionChoice,
  type GitOperation,
  type GitPullResult,
  type GitPullStrategy,
  type GitPushResult,
  type GitPushRewritten,
  type GitResolveResult,
  type GitStash,
  type GitStashFile,
  type GitStashRef
} from '../shared/git-types'
import { resolveInside } from './files'

const TIMEOUT_MS = 15_000
// Rede e hooks de commit demoram mais que um status; o login do Git Credential Manager pode abrir o navegador.
const NETWORK_TIMEOUT_MS = 180_000
const COMMIT_TIMEOUT_MS = 120_000
const MAX_DIFF_BYTES = 5 * 1024 * 1024
const MAX_BUFFER = 64 * 1024 * 1024
const NOT_A_REPO = /not a git repository/i

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout = ''
  ) {
    super(message)
  }
}

function gitEnv(literalPathspecs: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Nos caminhos vindos da interface, "[x].txt" é o arquivo, não um glob. Não vale para todo comando:
    // o check-ignore recusa pathspec com essa marca.
    ...(literalPathspecs && { GIT_LITERAL_PATHSPECS: '1' }),
    // O Claude/Codex e o git do usuário rodam no mesmo repo em paralelo: um `status` nosso
    // não pode pegar o index.lock e fazer o commit deles falhar.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    // Pull que vira merge abriria o editor da mensagem, que ninguém vê e travaria até o timeout.
    GIT_MERGE_AUTOEDIT: 'no',
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

function runGit(
  root: string,
  args: string[],
  opts: { input?: string; okCodes?: number[]; timeoutMs?: number; literalPathspecs?: boolean; noEditor?: boolean } = {}
): Promise<RunResult> {
  const okCodes = opts.okCodes ?? [0]
  const timeout = opts.timeoutMs ?? TIMEOUT_MS
  const env = gitEnv(opts.literalPathspecs === true)
  // `rebase --continue` e `cherry-pick --continue` abrem o editor da mensagem, que ninguém veria: `true` (o
  // builtin do sh do Git for Windows) aceita a mensagem que o git preparou.
  if (opts.noEditor) env.GIT_EDITOR = 'true'
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['--no-pager', '-c', 'color.ui=never', ...args],
      { cwd: root, env, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (!err) return resolvePromise({ stdout, code: 0 })
        if (err.code === 'ENOENT') {
          const message = existsSync(root)
            ? 'Git não encontrado. Instale o Git for Windows e garanta que o comando `git` esteja no PATH.'
            : `Pasta do projeto não existe: ${root}`
          return reject(new GitError(message, null, ''))
        }
        if (err.killed || err.signal) {
          return reject(new GitError(`O git demorou mais de ${timeout / 1000}s e foi interrompido (git ${args[0]}).`, null, stderr))
        }
        const code = typeof err.code === 'number' ? err.code : null
        if (code !== null && okCodes.includes(code)) return resolvePromise({ stdout, code })
        // Alguns motivos só saem no stdout (ex.: "nothing to commit").
        reject(new GitError(stderr.trim() || stdout.trim() || err.message, code, stderr, stdout))
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

interface RepoInfo {
  // O porcelain devolve caminhos relativos à raiz do repositório, que pode ser uma pasta acima do projeto.
  prefix: string
  // Numa worktree adicional, MERGE_HEAD e rebase-merge ficam na pasta dela; o stash fica na comum.
  gitDir: string
  commonDir: string
}

async function repoInfo(root: string): Promise<RepoInfo | null> {
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix', '--git-dir', '--git-common-dir'])
    const [inside, prefix = '', gitDir = '.git', commonDir = gitDir] = stdout.split(/\r?\n/)
    return inside === 'true' ? { prefix, gitDir: resolve(root, gitDir), commonDir: resolve(root, commonDir) } : null
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
        const code = record.slice(2, 4)
        if (path === undefined) break
        const file: GitFile = { path, status: 'conflicted', staged: false }
        if (CONFLICT_CODES.has(code)) file.conflict = code as GitConflictCode
        status.files.push(file)
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

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

const readOptional = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// O git comenta com "#" o que não vai para o commit (a lista "# Conflicts:"); com --file a mensagem não passa pela
// limpeza do editor, então essas linhas iriam para o commit.
export function cleanMergeMessage(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()
}

// Lê os arquivos de estado que o próprio git usa para saber o que está em andamento (é o que o `git status` faz).
export function detectOperation(gitDir: string): GitOperation | null {
  const number = (file: string): number | undefined => {
    const n = Number(readOptional(file)?.trim())
    return Number.isInteger(n) && n > 0 ? n : undefined
  }
  const headName = (file: string): string | undefined => readOptional(file)?.trim().replace(/^refs\/heads\//, '') || undefined
  const merge = join(gitDir, 'rebase-merge')
  if (isDirectory(merge)) {
    return { kind: 'rebase', head: headName(join(merge, 'head-name')), step: number(join(merge, 'msgnum')), total: number(join(merge, 'end')) }
  }
  const apply = join(gitDir, 'rebase-apply')
  // rebase-apply com "applying" é um `git am`, não um rebase.
  if (isDirectory(apply) && !existsSync(join(apply, 'applying'))) {
    return { kind: 'rebase', head: headName(join(apply, 'head-name')), step: number(join(apply, 'next')), total: number(join(apply, 'last')) }
  }
  const withMessage = (kind: GitOperation['kind']): GitOperation => {
    const message = cleanMergeMessage(readOptional(join(gitDir, 'MERGE_MSG')) ?? '')
    return message ? { kind, message } : { kind }
  }
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return withMessage('merge')
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return withMessage('cherry-pick')
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return withMessage('revert')
  return null
}

// O stash sempre grava o reflog de refs/stash: uma linha por entrada, sem precisar de outro processo do git.
function stashCount(commonDir: string): number {
  const log = readOptional(join(commonDir, 'logs', 'refs', 'stash'))
  return log ? log.split('\n').filter(Boolean).length : 0
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const info = await repoInfo(root)
  if (info === null) return { ...NOT_REPO, files: [] }
  const { prefix } = info
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
  const status = parsePorcelainV2(stdout, prefix)
  status.operation = detectOperation(info.gitDir)
  status.stashCount = stashCount(info.commonDir)
  return status
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
    if (err instanceof GitError) throw friendlyGitError(err, `Não foi possível criar a branch "${name}"`)
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

const OVERWRITTEN_BY_SWITCH = /would be overwritten by checkout|untracked working tree files would be overwritten by checkout/i

// O git lista os arquivos que barram a troca um por linha, indentados com tab, entre o aviso e o "Please commit".
export function overwrittenFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('\t'))
    .map((line) => line.trim())
    .filter(Boolean)
}

async function stashTop(root: string): Promise<string | null> {
  const { stdout, code } = await runGit(root, ['rev-parse', '--verify', '-q', 'refs/stash'], { okCodes: [1] })
  return code === 0 ? stdout.trim() : null
}

// Guarda tudo (com não rastreados, que também barram a troca) e devolve o stash criado; null se não havia nada.
async function stashForSwitch(root: string, name: string): Promise<string | null> {
  const before = await stashTop(root)
  await withHint('Não foi possível guardar as alterações no stash', () =>
    runGit(root, ['stash', 'push', '--include-untracked', '-m', `Kora: antes de trocar para ${name}`])
  )
  const after = await stashTop(root)
  return after !== null && after !== before ? after : null
}

// Sem `mode`, alteração local que seria sobrescrita não vira erro: volta a lista para a interface perguntar o que
// fazer (guardar, levar junto ou descartar), como o VS Code.
export async function gitCheckout(
  root: string,
  name: string,
  remote: string | null = null,
  mode: GitCheckoutMode = 'normal'
): Promise<GitCheckoutResult> {
  await assertBranchName(root, name)
  const args = await checkoutArgs(root, name, remote)
  if (mode === 'force') args.splice(1, 0, '--discard-changes')
  const stashed = mode === 'stash' || mode === 'migrate' ? await stashForSwitch(root, name) : null
  try {
    await runGit(root, args)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    if (mode === 'normal' && OVERWRITTEN_BY_SWITCH.test(err.stderr)) return { status: 'local-changes', files: overwrittenFiles(err.stderr) }
    const kept = stashed ? ' As alterações continuam guardadas no stash.' : ''
    throw friendlyGitError(err, `Não foi possível trocar para "${name}"`, kept)
  }
  if (mode !== 'migrate' || stashed === null) return { status: 'ok' }
  const index = (await gitStashList(root)).find((s) => s.oid === stashed)?.index
  if (index === undefined) throw new GitError(`Trocou para "${name}", mas o stash com as alterações sumiu da lista.`, null, '')
  const applied = await applyStash(
    root,
    { index, oid: stashed },
    true,
    'Não foi possível reaplicar as alterações',
    ` Você já está em "${name}"; as alterações continuam guardadas no stash.`
  )
  return { status: applied }
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

// Saídas do git que têm um próximo passo claro. A ordem importa: a primeira que casa vence (ex.: "Pulling is not
// possible because you have unmerged files" é merge em andamento antes de ser conflito).
const HINTS: [RegExp, string][] = [
  [
    /Please tell me who you are|Author identity unknown/i,
    'O git não sabe seu nome e e-mail. Configure com git config --global user.name e user.email e commite de novo.'
  ],
  [
    /index\.lock|Another git process seems to be running/i,
    'Outro processo do git está usando este repositório. Espere ele terminar e tente de novo.'
  ],
  [/nothing to commit|nothing added to commit|no changes added to commit/i, 'Nada na fila para commitar.'],
  [
    /Pulling is not possible because you have unmerged files|You have not concluded your merge|MERGE_HEAD exists/i,
    'Há um merge em andamento. Conclua ou aborte o merge antes.'
  ],
  [
    /unmerged files|unresolved conflict|you need to resolve your current index first|needs merge/i,
    'Há arquivos em conflito. Resolva e marque como resolvidos antes de continuar.'
  ],
  [
    /\(stale info\)/i,
    'O remoto recebeu commits depois da última busca; o push forçado foi cancelado para não apagá-los. Faça Pull e confira.'
  ],
  [
    /\[rejected\]|non-fast-forward|fetch first/i,
    'O remoto tem commits que você ainda não tem. Faça Pull (ou Sincronizar) antes do Push.'
  ],
  [
    /Not possible to fast-forward|Diverging branches can't be fast-forwarded|divergent branches|Need to specify how to reconcile/i,
    'Sua branch e a remota divergiram. Faça o Pull e escolha mesclar (merge) ou rebase.'
  ],
  [
    /cannot (pull with rebase|rebase): (You have unstaged changes|Your index contains uncommitted changes)/i,
    'O rebase precisa da árvore de trabalho limpa. Commite ou guarde as alterações no stash e tente de novo.'
  ],
  [
    /would be overwritten by checkout/i,
    'Trocar de branch sobrescreveria alterações locais. Guarde no stash, leve as alterações junto ou descarte-as.'
  ],
  [
    /local changes to the following files would be overwritten|untracked working tree files would be overwritten/i,
    'A operação sobrescreveria alterações locais. Commite ou guarde essas alterações no stash e tente de novo.'
  ],
  [
    /is already (used by worktree|checked out) at/i,
    'Essa branch já está aberta em outra worktree. Troque por lá ou use outra branch.'
  ],
  [/Automatic merge failed|CONFLICT \(/, 'A operação trouxe conflitos. Resolva os arquivos em Conflitos e marque como resolvidos.'],
  [
    /There is no tracking information|has no upstream branch|no upstream configured/i,
    'A branch ainda não existe no remoto. Publique com Push primeiro.'
  ],
  [/No stash entries found|is not a stash-like commit|is not a valid reference/i, 'Esse stash não existe mais. Atualize a lista.'],
  [
    /There is no merge to abort|No rebase in progress|no cherry-pick or revert in progress|no cherry-pick in progress/i,
    'Não há merge, rebase ou cherry-pick em andamento.'
  ],
  [
    /No changes - did you forget to use 'git add'|The previous cherry-pick is now empty/i,
    'Este passo ficou sem alterações depois da resolução. Pule pelo terminal (git rebase --skip ou git cherry-pick --skip) ou aborte.'
  ],
  [
    /Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i,
    'O git não conseguiu se autenticar no remoto. Faça login uma vez pelo terminal (ex.: git push) e tente de novo.'
  ],
  [
    /Could not resolve host|unable to access|Could not read from remote repository|does not appear to be a git repository/i,
    'Não foi possível falar com o remoto. Confira a conexão e a URL do repositório.'
  ]
]

export function explainGitOutput(output: string): string | null {
  return HINTS.find(([pattern]) => pattern.test(output))?.[1] ?? null
}

// A primeira linha é sempre português; a saída crua do git vai depois do separador, para "Detalhes".
// Erro sem código de saída é do Kora (validação, timeout, git ausente) e já está em português.
export function friendlyGitError(err: GitError, action: string, extra = ''): GitError {
  if (err.message.includes(GIT_ERROR_DETAIL)) return err
  const hint = explainGitOutput([err.message, err.stderr, err.stdout].join('\n'))
  if (!hint && err.exitCode === null) return extra ? new GitError(err.message + extra, null, err.stderr, err.stdout) : err
  const message = (hint ?? `${action}.`) + extra
  const raw = (err.stderr.trim() || err.stdout.trim() || err.message).trim()
  return new GitError(raw ? message + GIT_ERROR_DETAIL + raw : message, err.exitCode, err.stderr, err.stdout)
}

async function withHint<T>(action: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    throw friendlyGitError(err, action)
  }
}

const PATHSPEC_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul']

// Caminho do renderer (relativo ao projeto, com o separador do SO) conferido contra a raiz. O git roda com
// cwd na pasta do projeto, então esse mesmo caminho relativo serve de pathspec. A raiz não é um arquivo.
function projectRel(root: string, path: string): string {
  const rel = relative(root, resolveInside(root, path))
  if (!rel) throw new GitError('Caminho inválido: a pasta do projeto não é um arquivo.', null, '')
  return rel
}

const toGitPath = (rel: string): string => rel.split(sep).join('/')

// Pelo stdin, a lista não esbarra no limite de tamanho da linha de comando do Windows.
function pathspecs(root: string, paths: readonly string[]): string {
  if (paths.length === 0) throw new GitError('Nenhum arquivo informado.', null, '')
  return paths.map((p) => toGitPath(projectRel(root, p)) + '\0').join('')
}

export function gitStage(root: string, paths: readonly string[]): Promise<void> {
  return withHint('Não foi possível colocar na fila', async () => {
    await runGit(root, ['add', '-A', ...PATHSPEC_STDIN], { input: pathspecs(root, paths), literalPathspecs: true })
  })
}

// `reset` em vez de `restore --staged`: funciona também antes do primeiro commit, quando HEAD não existe.
export function gitUnstage(root: string, paths: readonly string[]): Promise<void> {
  return withHint('Não foi possível tirar da fila', async () => {
    await runGit(root, ['reset', '-q', ...PATHSPEC_STDIN], { input: pathspecs(root, paths), literalPathspecs: true })
  })
}

// Descarta só o que não está na fila: arquivo rastreado volta à versão do index; não rastreado vai para
// `trash` (a Lixeira, no app), porque o git não guarda cópia dele e apagar não teria volta.
export async function gitDiscard(root: string, paths: readonly string[], trash: (abs: string) => Promise<void>): Promise<void> {
  const wanted = new Set(paths.map((p) => projectRel(root, p)))
  const status = await gitStatus(root)
  if (!status.isRepo) throw new GitError('Esta pasta não é um repositório git.', null, '')
  const restore: string[] = []
  const untracked: string[] = []
  for (const file of status.files) {
    if (file.staged || !wanted.has(file.path)) continue
    if (file.status === 'conflicted') {
      throw new GitError(`"${file.path}" está em conflito. Resolva o conflito antes de descartar.`, null, '')
    }
    if (file.status === 'untracked') untracked.push(file.path)
    else restore.push(file.path)
  }
  if (restore.length > 0) {
    await withHint('Não foi possível descartar', async () => {
      await runGit(root, ['restore', '--worktree', ...PATHSPEC_STDIN], { input: pathspecs(root, restore), literalPathspecs: true })
    })
  }
  for (const rel of untracked) await trash(resolveInside(root, rel))
}

// Conteúdo do blob em `rev` (ex.: "HEAD:./a.txt", ":./a.txt"); null se o caminho não existe ali.
async function blobAt(root: string, rev: string): Promise<string | null> {
  const { stdout, code } = await runGit(root, ['rev-parse', '--verify', '-q', rev], { okCodes: [1] })
  if (code !== 0) return null
  const oid = stdout.trim()
  const size = Number((await runGit(root, ['cat-file', '-s', oid])).stdout.trim())
  if (size > MAX_DIFF_BYTES) throw new GitError('Arquivo grande demais para mostrar o diff aqui.', null, '')
  return (await runGit(root, ['cat-file', 'blob', oid])).stdout
}

function diskText(file: string): string {
  if (!existsSync(file)) return ''
  if (statSync(file).size > MAX_DIFF_BYTES) throw new GitError('Arquivo grande demais para mostrar o diff aqui.', null, '')
  return readFileSync(file, 'utf8')
}

export async function gitDiff(root: string, path: string, staged: boolean): Promise<GitDiff> {
  const rel = projectRel(root, path)
  const spec = `./${toGitPath(rel)}`
  let original: string
  let modified: string
  if (staged) {
    const entry = (await gitStatus(root)).files.find((f) => f.staged && f.path === rel)
    const from = entry?.origPath ? `./${toGitPath(entry.origPath)}` : spec
    original = (await blobAt(root, `HEAD:${from}`)) ?? ''
    modified = (await blobAt(root, `:${spec}`)) ?? ''
  } else {
    original = (await blobAt(root, `:${spec}`)) ?? ''
    modified = diskText(resolveInside(root, rel))
  }
  if (original.includes('\0') || modified.includes('\0')) return { original: '', modified: '', binary: true }
  return { original, modified, binary: false }
}

// Fila vazia devolve 'nothing-staged' sem commitar: quem decide é o index de agora, não o status que a
// interface tinha (pode estar atrasado). A interface pergunta e chama de novo com `stageAll`, que coloca
// antes todas as alterações do projeto (o "commit inteligente" do VS Code).
export async function gitCommit(root: string, message: string, stageAll: boolean): Promise<GitCommitResult> {
  if (!message.trim()) throw new GitError('Escreva a mensagem do commit.', null, '')
  return withHint('O commit falhou', async () => {
    if (stageAll) await runGit(root, ['add', '-A', '--', '.'])
    // Merge em que a resolução ficou igual ao HEAD ainda precisa do commit de merge, mesmo sem diff na fila.
    else if (!(await mergeInProgress(root)) && (await runGit(root, ['diff', '--cached', '--quiet'], { okCodes: [1] })).code === 0) {
      return 'nothing-staged'
    }
    // Mensagem pelo stdin: várias linhas, acentos e aspas chegam intactos.
    await runGit(root, ['commit', '--file=-'], { input: message, timeoutMs: COMMIT_TIMEOUT_MS })
    return 'committed'
  })
}

async function currentBranch(root: string): Promise<GitStatus & { branch: string }> {
  const status = await gitStatus(root)
  if (!status.isRepo) throw new GitError('Esta pasta não é um repositório git.', null, '')
  if (status.detached || !status.branch) {
    throw new GitError('HEAD destacado: troque para uma branch antes de enviar ou receber commits.', null, '')
  }
  return { ...status, branch: status.branch }
}

async function publishRemote(root: string): Promise<string> {
  const remotes = (await runGit(root, ['remote'])).stdout.split(/\r?\n/).filter(Boolean)
  if (remotes.includes('origin')) return 'origin'
  if (remotes.length === 1) return remotes[0]!
  throw new GitError(
    remotes.length === 0
      ? 'Sem repositório remoto. Vincule ao GitHub antes do Push.'
      : 'Há mais de um remoto e nenhum se chama origin. Publique a branch pelo terminal.',
    null,
    ''
  )
}

// Commits do upstream que faltam aqui. Se todos já foram desta branch (estão no reflog dela), quem os tirou foi um
// "corrigir" ou "desfazer commit" local, não um colega: Pull traria de volta o que foi corrigido, e o caminho é o
// push forçado. Usa a ref de rastreamento do último fetch; se o remoto andou desde então, o lease recusa o push.
async function rewrittenUpstream(root: string, status: GitStatus & { branch: string }): Promise<GitPushRewritten | null> {
  if (!status.upstream || status.behind === 0) return null
  const remoteOid = (await runGit(root, ['rev-parse', '--verify', '@{upstream}'])).stdout.trim()
  const reflog = (await runGit(root, ['reflog', 'show', '--format=%H', `refs/heads/${status.branch}`])).stdout.split(/\r?\n/).filter(Boolean)
  const input = ['@{upstream}', '^HEAD', ...reflog.map((oid) => `^${oid}`)].join('\n') + '\n'
  if ((await runGit(root, ['rev-list', '--stdin'], { input })).stdout.trim()) return null
  const { stdout } = await runGit(root, ['log', '--format=%H%x1f%s', 'HEAD..@{upstream}'])
  const lost = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = ''] = line.split('\x1f')
      return { hash, subject }
    })
  return { status: 'rewritten', upstream: status.upstream, remoteOid, lost }
}

async function upstreamTarget(root: string, branch: string): Promise<{ remote: string; ref: string }> {
  const get = async (key: string): Promise<string> => (await runGit(root, ['config', '--get', key], { okCodes: [1] })).stdout.trim()
  const remote = await get(`branch.${branch}.remote`)
  const ref = await get(`branch.${branch}.merge`)
  if (!remote || !ref.startsWith('refs/heads/')) throw new GitError(`A branch "${branch}" não tem upstream configurado para o push forçado.`, null, '')
  return { remote, ref }
}

// Branch sem upstream é publicada no remoto e passa a rastreá-lo, como o "Publicar branch" do VS Code.
// `forceWithLease`: o oid que o remoto precisa ter para ser sobrescrito (o `remoteOid` mostrado ao usuário); nunca
// --force puro, para não apagar o que alguém enviou depois.
export async function gitPush(root: string, opts: { forceWithLease?: string } = {}): Promise<GitPushResult> {
  const status = await currentBranch(root)
  const lease = opts.forceWithLease
  if (lease !== undefined) {
    if (!/^[0-9a-f]{40,64}$/.test(lease)) throw new GitError('Push forçado inválido.', null, '')
    const { remote, ref } = await upstreamTarget(root, status.branch)
    await withHint('O push forçado falhou', () =>
      runGit(root, ['push', `--force-with-lease=${ref}:${lease}`, remote, `HEAD:${ref}`], { timeoutMs: NETWORK_TIMEOUT_MS })
    )
    return { status: 'ok' }
  }
  const rewritten = await rewrittenUpstream(root, status)
  if (rewritten) return rewritten
  const args = status.upstream ? ['push'] : ['push', '-u', await publishRemote(root), `refs/heads/${status.branch}`]
  await withHint('O Push falhou', () => runGit(root, args, { timeoutMs: NETWORK_TIMEOUT_MS }))
  return { status: 'ok' }
}

const DIVERGED = /Not possible to fast-forward|Diverging branches can't be fast-forwarded|divergent branches|Need to specify how to reconcile/i

async function hasConfig(root: string, key: string): Promise<boolean> {
  return (await runGit(root, ['config', '--get', key], { okCodes: [1] })).code === 0
}

async function pullArgs(root: string, strategy: GitPullStrategy): Promise<string[]> {
  // A escolha explícita na linha de comando vence o pull.rebase/pull.ff=only da config.
  if (strategy === 'merge') return ['pull', '--no-rebase']
  if (strategy === 'rebase') return ['pull', '--rebase']
  // Quem configurou como o pull junta as branches recebe isso; sem config, só avança e divergência vira pergunta.
  if ((await hasConfig(root, 'pull.rebase')) || (await hasConfig(root, 'pull.ff'))) return ['pull']
  return ['pull', '--ff-only']
}

const conflictCount = (status: GitStatus): number => status.files.filter((f) => f.status === 'conflicted').length

// Ação que pode parar no meio com conflito (pull, rebase --continue, stash apply): conflito novo não é erro, é o
// estado que o painel mostra. Conflito que já existia antes não conta.
async function allowingConflicts(root: string, action: string, task: () => Promise<unknown>, extra = ''): Promise<'ok' | 'conflicts'> {
  const before = conflictCount(await gitStatus(root))
  try {
    await task()
    return 'ok'
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    if (before === 0 && conflictCount(await gitStatus(root)) > 0) return 'conflicts'
    throw friendlyGitError(err, action, extra)
  }
}

export async function gitPull(root: string, strategy: GitPullStrategy = 'default'): Promise<GitPullResult> {
  const status = await currentBranch(root)
  if (!status.upstream) {
    throw new GitError(`A branch "${status.branch}" ainda não existe no remoto. Publique com Push primeiro.`, null, '')
  }
  if (status.operation) throw new GitError(`Há ${OPERATION_LABEL[status.operation.kind]} em andamento. Conclua ou aborte antes do Pull.`, null, '')
  if (conflictCount(status) > 0) throw new GitError('Há arquivos em conflito. Resolva e marque como resolvidos antes do Pull.', null, '')
  const args = await pullArgs(root, strategy)
  try {
    const result = await allowingConflicts(root, 'O Pull falhou', () => runGit(root, args, { timeoutMs: NETWORK_TIMEOUT_MS }))
    return { status: result }
  } catch (err) {
    if (!(err instanceof GitError) || !DIVERGED.test(err.stderr)) throw err
    // O pull já buscou: a contagem é contra o remoto de agora, não o do último fetch.
    const { stdout } = await runGit(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const [ahead = 0, behind = 0] = stdout.trim().split(/\s+/).map(Number)
    return { status: 'diverged', ahead, behind, upstream: status.upstream }
  }
}

export async function gitFetch(root: string): Promise<void> {
  await withHint('Não foi possível buscar do remoto', () => runGit(root, ['fetch'], { timeoutMs: NETWORK_TIMEOUT_MS }))
}

// Histórico reescrito para antes do Pull: o Pull juntaria de volta o commit que foi corrigido ou desfeito.
export async function gitSync(root: string, strategy: GitPullStrategy = 'default'): Promise<GitPullResult | GitPushRewritten> {
  const status = await currentBranch(root)
  if (status.upstream) {
    const rewritten = await rewrittenUpstream(root, status)
    if (rewritten) return rewritten
    const pulled = await gitPull(root, strategy)
    if (pulled.status !== 'ok') return pulled
  }
  return gitPush(root)
}

const OPERATION_LABEL: Record<GitOperation['kind'], string> = {
  merge: 'um merge',
  rebase: 'um rebase',
  'cherry-pick': 'um cherry-pick',
  revert: 'um revert'
}

async function mergeInProgress(root: string): Promise<boolean> {
  const info = await repoInfo(root)
  return info !== null && existsSync(join(info.gitDir, 'MERGE_HEAD'))
}

async function operationOf(root: string): Promise<{ status: GitStatus; operation: GitOperation }> {
  const status = await gitStatus(root)
  if (!status.isRepo) throw new GitError('Esta pasta não é um repositório git.', null, '')
  if (!status.operation) throw new GitError('Não há merge, rebase ou cherry-pick em andamento.', null, '')
  return { status, operation: status.operation }
}

export async function gitAbortOperation(root: string): Promise<void> {
  const { operation } = await operationOf(root)
  await withHint(`Não foi possível abortar ${OPERATION_LABEL[operation.kind]}`, () => runGit(root, [operation.kind, '--abort']))
}

// Merge conclui com o commit de merge e a mensagem dada (a da caixa de commit, preenchida com a do git). Rebase,
// cherry-pick e revert seguem com `--continue` e a mensagem que o git guardou para o passo.
export async function gitContinueOperation(root: string, message: string): Promise<GitContinueResult> {
  const { status, operation } = await operationOf(root)
  const pending = conflictCount(status)
  if (pending > 0) {
    throw new GitError(
      pending === 1 ? 'Ainda há 1 arquivo em conflito. Resolva e marque como resolvido antes de concluir.' : `Ainda há ${pending} arquivos em conflito. Resolva e marque como resolvidos antes de concluir.`,
      null,
      ''
    )
  }
  if (operation.kind === 'merge') {
    const text = message.trim() || operation.message
    if (!text) throw new GitError('Escreva a mensagem do commit de merge.', null, '')
    await withHint('Não foi possível concluir o merge', () => runGit(root, ['commit', '--file=-'], { input: text, timeoutMs: COMMIT_TIMEOUT_MS }))
    return 'done'
  }
  const result = await allowingConflicts(root, `Não foi possível continuar ${OPERATION_LABEL[operation.kind]}`, () =>
    runGit(root, [operation.kind, '--continue'], { timeoutMs: COMMIT_TIMEOUT_MS, noEditor: true })
  )
  return result === 'ok' ? 'done' : 'conflicts'
}

const MARKER_START = /^<{7}(?: |\r?$)/m
const MARKER_END = /^>{7}(?: |\r?$)/m
const MAX_MARKER_SCAN_BYTES = 20 * 1024 * 1024

// Só início ou fim de bloco contam: uma linha "=======" sozinha é o sublinhado de título do Markdown.
export function hasConflictMarkers(text: string): boolean {
  return MARKER_START.test(text) || MARKER_END.test(text)
}

function fileHasMarkers(file: string): boolean {
  try {
    if (statSync(file).size > MAX_MARKER_SCAN_BYTES) return false
    const text = readFileSync(file, 'utf8')
    return !text.includes('\0') && hasConflictMarkers(text)
  } catch {
    return false
  }
}

// Um lado apagou e o outro mudou (ou só um lado adicionou): o arquivo no disco é a versão de um dos lados e
// colocar na fila escolheria essa versão sem perguntar.
const NEEDS_CHOICE = new Set<GitConflictCode>(['DU', 'UD', 'AU', 'UA'])

// Marca como resolvido, como o "Preparar" do VS Code num arquivo da seção de conflitos: recusa (devolvendo a
// lista) arquivo que ainda tem marcadores, a menos que `force`; conflito de exclusão exige `deletion`.
export async function gitResolve(
  root: string,
  paths: readonly string[],
  opts: { force?: boolean; deletion?: GitDeletionChoice } = {}
): Promise<GitResolveResult> {
  const wanted = new Set(paths.map((p) => projectRel(root, p)))
  if (wanted.size === 0) throw new GitError('Nenhum arquivo informado.', null, '')
  const status = await gitStatus(root)
  if (!status.isRepo) throw new GitError('Esta pasta não é um repositório git.', null, '')
  const conflicted = status.files.filter((f) => f.status === 'conflicted' && wanted.has(f.path))
  const choice = conflicted.filter((f) => f.conflict && NEEDS_CHOICE.has(f.conflict))
  const first = choice[0]
  if (first && !opts.deletion) return { status: 'needs-choice', path: first.path, conflict: first.conflict! }
  if (!opts.force) {
    const marked = conflicted.filter((f) => !choice.includes(f) && fileHasMarkers(resolveInside(root, f.path))).map((f) => f.path)
    if (marked.length > 0) return { status: 'has-markers', paths: marked }
  }
  const remove = opts.deletion === 'delete' ? choice.map((f) => f.path) : []
  const add = [...wanted].filter((p) => !remove.includes(p))
  await withHint('Não foi possível marcar como resolvido', async () => {
    if (add.length > 0) await runGit(root, ['add', '-A', ...PATHSPEC_STDIN], { input: pathspecs(root, add), literalPathspecs: true })
    if (remove.length > 0) await runGit(root, ['rm', '-q', '--force', ...PATHSPEC_STDIN], { input: pathspecs(root, remove), literalPathspecs: true })
  })
  return { status: 'resolved' }
}

// %x1f separa os campos: a mensagem do stash é texto livre. -z separa as entradas.
const STASH_FORMAT = '%H%x1f%gd%x1f%gs%x1f%ct'

export function parseStashList(output: string, nowMs = Date.now()): GitStash[] {
  const stashes: GitStash[] = []
  for (const record of output.split('\0')) {
    const [oid = '', selector = '', subject = '', unix = ''] = record.replace(/^\r?\n/, '').split('\x1f')
    const index = /^stash@\{(\d+)\}$/.exec(selector)?.[1]
    if (!oid || index === undefined) continue
    // "WIP on main: abc1234 assunto" (sem mensagem) ou "On main: mensagem". Nome de branch não pode ter ":".
    const m = /^(?:WIP on|On) ([^:]+): ([\s\S]*)$/.exec(subject)
    const branch = m && m[1] !== '(no branch)' ? m[1]! : null
    stashes.push({ index: Number(index), oid, message: m ? m[2]! : subject, branch, relative: relativeTime(Number(unix), nowMs) })
  }
  return stashes
}

export async function gitStashList(root: string): Promise<GitStash[]> {
  try {
    const { stdout } = await runGit(root, ['stash', 'list', '-z', `--format=${STASH_FORMAT}`])
    return parseStashList(stdout)
  } catch (err) {
    if (isNotRepo(err)) return []
    throw err
  }
}

export async function gitStashPush(root: string, message: string, includeUntracked: boolean): Promise<void> {
  const before = await stashTop(root)
  const args = ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), ...(message.trim() ? ['-m', message.trim()] : [])]
  await withHint('Não foi possível guardar no stash', () => runGit(root, args))
  // Sem nada para guardar o git sai com 0 e só avisa "No local changes to save".
  if ((await stashTop(root)) === before) {
    throw new GitError(
      includeUntracked ? 'Não há alterações para guardar no stash.' : 'Não há alterações rastreadas para guardar. Para arquivos novos, marque "Incluir não rastreados".',
      null,
      ''
    )
  }
}

const STALE_STASH_LIST = 'A lista de stash mudou (outro programa mexeu nela). Atualize e tente de novo.'

// O índice de um stash muda quando outro programa (um agente, o terminal) guarda ou remove um: o oid confere que
// `stash@{n}` ainda é o que a interface mostrou.
async function stashSelector(root: string, ref: GitStashRef): Promise<string> {
  if (!Number.isInteger(ref.index) || ref.index < 0 || !/^[0-9a-f]{40,64}$/.test(ref.oid)) {
    throw new GitError('Stash inválido.', null, '')
  }
  const selector = `stash@{${ref.index}}`
  const { stdout, code } = await runGit(root, ['rev-parse', '--verify', '-q', selector], { okCodes: [1] })
  if (code !== 0 || stdout.trim() !== ref.oid) {
    throw new GitError(STALE_STASH_LIST, null, '')
  }
  return selector
}

// `git stash drop` só aceita a posição, e outro programa pode guardar um stash entre a conferência e o drop: a saída
// diz qual oid saiu. Se não era o pedido, ele volta para o topo (de onde um stash recém-guardado acabou de sair) com
// a mesma mensagem, e o drop vai de novo atrás do oid pedido.
async function dropStash(root: string, ref: GitStashRef, action: string): Promise<void> {
  let index = ref.index
  for (let attempt = 0; attempt < 3; attempt++) {
    const { stdout } = await withHint(action, () => runGit(root, ['stash', 'drop', `stash@{${index}}`]))
    const dropped = /\(([0-9a-f]{40,64})\)/.exec(stdout)?.[1]
    if (dropped === undefined || dropped === ref.oid) return
    const { stdout: subject } = await runGit(root, ['log', '-1', '--format=%s', dropped])
    await runGit(root, ['stash', 'store', '-m', subject.trim(), dropped])
    const current = (await gitStashList(root)).find((s) => s.oid === ref.oid)
    if (!current) return
    index = current.index
  }
  throw new GitError(STALE_STASH_LIST, null, '')
}

async function applyStash(root: string, ref: GitStashRef, pop: boolean, action: string, extra = ''): Promise<'ok' | 'conflicts'> {
  await stashSelector(root, ref)
  // Pelo oid: o status que o allowingConflicts roda antes dá tempo de outro programa guardar um stash e empurrar
  // as posições. Conflito ao aplicar não remove o stash nem no pop, então nada se perde.
  const result = await allowingConflicts(root, action, () => runGit(root, ['stash', 'apply', ref.oid]), extra)
  if (pop && result === 'ok') {
    const current = (await gitStashList(root)).find((s) => s.oid === ref.oid)
    if (current) await dropStash(root, current, action)
  }
  return result
}

export async function gitStashApply(root: string, ref: GitStashRef, pop: boolean): Promise<'ok' | 'conflicts'> {
  return applyStash(root, ref, pop, 'Não foi possível aplicar o stash')
}

export async function gitStashDrop(root: string, ref: GitStashRef): Promise<void> {
  await stashSelector(root, ref)
  await dropStash(root, ref, 'Não foi possível remover o stash')
}

// Caminhos relativos à raiz do repositório, com "/". Inclui os não rastreados guardados com -u.
export async function gitStashFiles(root: string, ref: GitStashRef): Promise<GitStashFile[]> {
  const selector = await stashSelector(root, ref)
  const { stdout } = await withHint('Não foi possível listar o stash', () =>
    runGit(root, ['stash', 'show', '--include-untracked', '--name-status', '-z', selector])
  )
  const fields = stdout.split('\0')
  const files: GitStashFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!
    if (!code) continue
    // Rename e cópia trazem dois caminhos: o de origem e o novo.
    if (/^[RC]/.test(code)) i++
    const path = fields[++i]
    if (path) files.push({ status: code[0]!, path })
  }
  return files
}

// Para os módulos de histórico, branches, .gitignore e trechos (git-history.ts e vizinhos).
export { assertBranchName, blobAt, gitEnv, isNotRepo, projectRel, publishRemote, runGit, toGitPath, withHint }
