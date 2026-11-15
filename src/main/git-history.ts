import { join } from 'node:path'
import type {
  GitCommitFile,
  GitDiff,
  GitFileStatus,
  GitHeadCommit,
  GitLogCommit,
  GitLogPage,
  GitOperationKind,
  GitRef
} from '../shared/git-types'
import { blobAt, GitError, gitStatus, isNotRepo, projectRel, relativeTime, runGit, toGitPath, withHint } from './git'

const COMMIT_TIMEOUT_MS = 120_000
const OPERATION_NAME: Record<GitOperationKind, string> = {
  merge: 'um merge',
  rebase: 'um rebase',
  'cherry-pick': 'um cherry-pick',
  revert: 'um revert'
}
export const LOG_PAGE_MAX = 500

// %x1e fecha cada commit: assunto e corpo são texto livre e não servem de delimitador.
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s', '%b'].join('%x00') + '%x1e'

// Com --decorate=full: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". Nome de ref
// não pode ter espaço, então ", " separa sem ambiguidade.
export function parseRefs(decoration: string): GitRef[] {
  const refs: GitRef[] = []
  for (const raw of decoration.split(', ')) {
    const item = raw.trim()
    if (!item) continue
    if (item === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' })
    else if (item.startsWith('HEAD -> ')) refs.push({ name: item.slice(8).replace(/^refs\/heads\//, ''), kind: 'branch', current: true })
    else if (item.startsWith('tag: ')) refs.push({ name: item.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag' })
    else if (item.startsWith('refs/heads/')) refs.push({ name: item.slice(11), kind: 'branch' })
    else if (item.startsWith('refs/remotes/')) {
      // origin/HEAD só aponta para outra remota da lista.
      if (!item.endsWith('/HEAD')) refs.push({ name: item.slice(13), kind: 'remote' })
    }
  }
  return refs
}

export function parseLog(output: string, nowMs = Date.now()): GitLogCommit[] {
  const commits: GitLogCommit[] = []
  for (const record of output.split('\x1e')) {
    const fields = record.replace(/^\r?\n/, '').split('\0')
    const [hash = '', parents = '', author = '', email = '', at = '', decoration = '', subject = '', body = ''] = fields
    if (!/^[0-9a-f]{40,64}$/.test(hash)) continue
    const date = Number(at)
    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      author,
      email,
      date,
      relative: relativeTime(date, nowMs),
      subject,
      body: body.replace(/\s+$/, ''),
      refs: parseRefs(decoration)
    })
  }
  return commits
}

async function hasHead(root: string): Promise<boolean> {
  const { code } = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { okCodes: [1] })
  return code === 0
}

async function repoPrefix(root: string): Promise<string> {
  return (await runGit(root, ['rev-parse', '--show-prefix'])).stdout.trim()
}

const intIn = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback

// Com `path`, o histórico daquele arquivo seguindo renomeações. Sem, o do repositório; se o projeto é uma
// subpasta, só os commits que mexem nela (o mesmo recorte do status).
export async function gitLog(
  root: string,
  opts: { skip?: number; limit?: number; path?: string } = {}
): Promise<GitLogPage> {
  const skip = intIn(opts.skip, 0, Number.MAX_SAFE_INTEGER, 0)
  const limit = intIn(opts.limit, 1, LOG_PAGE_MAX, 50)
  try {
    if (!(await hasHead(root))) return { commits: [], hasMore: false }
    const args = ['log', '--no-show-signature', '--decorate=full', `--format=${LOG_FORMAT}`, `--skip=${skip}`, '-n', String(limit + 1)]
    if (opts.path !== undefined) args.push('--follow', '--', toGitPath(projectRel(root, opts.path)))
    // Pathspec só quando precisa: com ele o git simplifica o histórico e some com os commits de merge.
    else if (await repoPrefix(root)) args.push('--', '.')
    const { stdout } = await runGit(root, args, { literalPathspecs: true })
    const commits = parseLog(stdout)
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
  } catch (err) {
    if (isNotRepo(err)) return { commits: [], hasMore: false }
    throw err
  }
}

const HASH = /^[0-9a-f]{4,64}$/i

async function resolveCommit(root: string, hash: string): Promise<{ hash: string; parents: string[] }> {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new GitError(`Commit inválido: "${String(hash)}"`, null, '')
  const { stdout, code } = await runGit(root, ['rev-list', '--parents', '-n', '1', `${hash}^{commit}`, '--'], { okCodes: [128] })
  const [full, ...parents] = stdout.trim().split(' ')
  if (code !== 0 || !full) throw new GitError(`O commit ${hash.slice(0, 7)} não existe neste repositório.`, null, '')
  return { hash: full, parents }
}

function statusOf(letter: string): GitFileStatus {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'added'
    default:
      return 'modified'
  }
}

const localPath = (gitPath: string): string => join(...gitPath.split('/'))

// Saída de `diff-tree -z --name-status`: "M\0caminho\0", e no rename "R100\0antigo\0novo\0".
export function parseNameStatus(output: string): GitCommitFile[] {
  const fields = output.split('\0')
  const files: GitCommitFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const letter = fields[i]!
    if (!/^[ACDMRTUX]\d*$/.test(letter)) continue
    if (letter[0] === 'R' || letter[0] === 'C') {
      const from = fields[++i]
      const to = fields[++i]
      if (from === undefined || to === undefined) break
      const file: GitCommitFile = { path: localPath(to), status: statusOf(letter) }
      if (letter[0] === 'R') file.origPath = localPath(from)
      files.push(file)
    } else {
      const path = fields[++i]
      if (path === undefined) break
      files.push({ path: localPath(path), status: statusOf(letter) })
    }
  }
  return files
}

// Contra o primeiro pai, como o VS Code; o commit inicial contra o vazio. `--relative` deixa os caminhos
// relativos ao projeto e esconde o que está fora dele.
export async function gitCommitFiles(root: string, hash: string): Promise<GitCommitFile[]> {
  const commit = await resolveCommit(root, hash)
  const base = ['diff-tree', '-r', '-z', '--name-status', '-M', '--relative', '--no-ext-diff', '--no-commit-id']
  const args = commit.parents[0] ? [...base, commit.parents[0], commit.hash] : [...base, '--root', commit.hash]
  return parseNameStatus((await runGit(root, args)).stdout)
}

export async function gitCommitDiff(root: string, hash: string, path: string, origPath?: string): Promise<GitDiff> {
  const commit = await resolveCommit(root, hash)
  const spec = `./${toGitPath(projectRel(root, path))}`
  const from = origPath ? `./${toGitPath(projectRel(root, origPath))}` : spec
  const original = commit.parents[0] ? ((await blobAt(root, `${commit.parents[0]}:${from}`)) ?? '') : ''
  const modified = (await blobAt(root, `${commit.hash}:${spec}`)) ?? ''
  if (original.includes('\0') || modified.includes('\0')) return { original: '', modified: '', binary: true }
  return { original, modified, binary: false }
}

// "Abrir arquivo (HEAD)": o conteúdo do arquivo num commit; vazio se ele não existia ali.
export async function gitFileAt(root: string, rev: string, path: string): Promise<{ text: string; binary: boolean; exists: boolean }> {
  const commit = rev === 'HEAD' ? { hash: 'HEAD' } : await resolveCommit(root, rev)
  const text = await blobAt(root, `${commit.hash}:./${toGitPath(projectRel(root, path))}`)
  if (text === null) return { text: '', binary: false, exists: false }
  if (text.includes('\0')) return { text: '', binary: true, exists: true }
  return { text, binary: false, exists: true }
}

export async function gitHeadCommit(root: string): Promise<GitHeadCommit | null> {
  try {
    if (!(await hasHead(root))) return null
  } catch (err) {
    if (isNotRepo(err)) return null
    throw err
  }
  const [{ stdout: parents }, { stdout: message }, { stdout: remotes }] = await Promise.all([
    runGit(root, ['rev-list', '--parents', '-n', '1', 'HEAD', '--']),
    runGit(root, ['log', '-1', '--no-show-signature', '--format=%B', 'HEAD', '--']),
    runGit(root, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes/'])
  ])
  const [hash = '', ...rest] = parents.trim().split(' ')
  return {
    hash,
    message: message.replace(/\s+$/, ''),
    isRoot: rest.length === 0,
    pushed: remotes.split(/\r?\n/).some((ref) => ref !== '' && !ref.endsWith('/HEAD'))
  }
}

// "Confirmar (Corrigir)" do VS Code: refaz o último commit com a mensagem dada e o que estiver na fila.
export async function gitCommitAmend(root: string, message: string): Promise<void> {
  if (typeof message !== 'string' || !message.trim()) throw new GitError('Escreva a mensagem do commit.', null, '')
  if (!(await hasHead(root))) throw new GitError('Ainda não há commit para corrigir.', null, '')
  await withHint('Não foi possível corrigir o último commit', async () => {
    await runGit(root, ['commit', '--amend', '--file=-'], { input: message, timeoutMs: COMMIT_TIMEOUT_MS })
  })
}

// "Desfazer última confirmação": o commit some e as alterações dele voltam para a fila (reset --soft). O
// update-ref com o valor esperado não move a branch se outro processo commitou entre a leitura e a escrita.
export async function gitUndoLastCommit(root: string): Promise<{ message: string }> {
  const head = await gitHeadCommit(root)
  if (!head) throw new GitError('Ainda não há commit para desfazer.', null, '')
  if (head.isRoot) throw new GitError('Este é o primeiro commit do repositório: não há commit anterior para onde voltar.', null, '')
  // O reset --soft do git recusa no meio de um merge; o update-ref não confere, então a recusa fica aqui.
  const operation = (await gitStatus(root)).operation
  if (operation) {
    throw new GitError(`Há ${OPERATION_NAME[operation.kind]} em andamento. Conclua ou aborte antes de desfazer o último commit.`, null, '')
  }
  const parent = (await runGit(root, ['rev-parse', '--verify', `${head.hash}^1`])).stdout.trim()
  await withHint('Não foi possível desfazer o último commit', async () => {
    await runGit(root, ['update-ref', '-m', 'reset: desfazer o último commit (Kora)', 'HEAD', parent, head.hash])
  })
  return { message: head.message }
}
