import { execFile, type ExecFileException } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { GitHunk, GitHunkAction } from '../shared/git-types'
import { GitError, gitEnv, projectRel, toGitPath } from './git'

const TIMEOUT_MS = 15_000
const MAX_BUFFER = 64 * 1024 * 1024

// O patch vai e volta como latin1 (um caractere por byte): arquivo em Windows-1252 ou com UTF-8 inválido
// passaria pelo UTF-8 com perda e o `git apply` recusaria o trecho, ou gravaria bytes trocados.
function runBytes(root: string, args: string[], input = ''): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['--no-pager', '-c', 'color.ui=never', ...args],
      { cwd: root, env: gitEnv(true), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'latin1' },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (!err) return resolvePromise(stdout)
        if (err.code === 'ENOENT') return reject(new GitError('Git não encontrado. Instale o Git for Windows e garanta que o comando `git` esteja no PATH.', null, ''))
        const text = Buffer.from(stderr, 'latin1').toString('utf8').trim()
        reject(new GitError(text || err.message, typeof err.code === 'number' ? err.code : null, text))
      }
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input, 'latin1')
  })
}

interface ParsedHunk extends GitHunk {
  text: string
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// Um arquivo por patch: o cabeçalho (diff --git, index, ---/+++) e cada bloco "@@" com as linhas dele,
// inclusive "\ No newline at end of file". O `\r` do CRLF fica dentro da linha, intacto.
export function parseHunks(patch: string): { header: string; hunks: ParsedHunk[] } {
  const lines = patch.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const first = lines.findIndex((line) => line.startsWith('@@ '))
  if (first === -1) return { header: '', hunks: [] }
  if (lines.filter((line) => line.startsWith('diff --git ')).length > 1) return { header: '', hunks: [] }
  const header = lines.slice(0, first).map((line) => `${line}\n`).join('')
  const hunks: ParsedHunk[] = []
  for (let i = first; i < lines.length; ) {
    const m = HUNK_HEADER.exec(lines[i]!)
    if (!m) break
    let end = i + 1
    while (end < lines.length && !lines[end]!.startsWith('@@ ')) end++
    const text = lines.slice(i, end).map((line) => `${line}\n`).join('')
    hunks.push({
      id: createHash('sha1').update(text, 'latin1').digest('hex'),
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      text
    })
    i = end
  }
  return { header, hunks }
}

// Sem contexto (-U0): cada bloco alterado vira um trecho separado, como os blocos do diff do VS Code.
// Prefixos fixos e sem diff externo/textconv: a config do usuário não pode mudar o formato do patch.
async function filePatch(root: string, path: string, staged: boolean): Promise<string> {
  const spec = toGitPath(projectRel(root, path))
  const args = ['diff', ...(staged ? ['--cached'] : []), '-U0', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--', spec]
  return runBytes(root, args)
}

const stripText = ({ id, oldStart, oldLines, newStart, newLines }: ParsedHunk): GitHunk => ({ id, oldStart, oldLines, newStart, newLines })

export async function gitHunks(root: string, path: string, staged: boolean): Promise<GitHunk[]> {
  return parseHunks(await filePatch(root, path, staged)).hunks.map(stripText)
}

// O diff é refeito na hora: o trecho só é aplicado se ainda for idêntico ao que a interface mostrou.
export async function gitApplyHunk(root: string, path: string, staged: boolean, hunkId: string, action: GitHunkAction): Promise<void> {
  if ((action === 'unstage') !== staged) throw new GitError('Ação de trecho inválida para este diff.', null, '')
  const { header, hunks } = parseHunks(await filePatch(root, path, staged))
  const hunk = hunks.find((h) => h.id === hunkId)
  if (!hunk) throw new GitError('O trecho mudou desde que o diff foi mostrado. Confira o diff atualizado e tente de novo.', null, '')
  const args = ['apply', '--unidiff-zero', '--whitespace=nowarn']
  if (action !== 'discard') args.push('--cached')
  if (action !== 'stage') args.push('--reverse')
  try {
    await runBytes(root, [...args, '-'], header + hunk.text)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    const verb = action === 'stage' ? 'colocar o trecho na fila' : action === 'unstage' ? 'tirar o trecho da fila' : 'descartar o trecho'
    throw new GitError(`Não foi possível ${verb}: ${err.message}`, err.exitCode, err.stderr)
  }
}
