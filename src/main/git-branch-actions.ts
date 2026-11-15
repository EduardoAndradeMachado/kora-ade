import type { GitBranchDeleteResult } from '../shared/git-types'
import { assertBranchName, GitError, gitBranches, publishRemote, runGit, withHint } from './git'

const NETWORK_TIMEOUT_MS = 180_000

async function localBranch(root: string, name: string): Promise<{ current: boolean; upstream: string | null }> {
  await assertBranchName(root, name)
  const branch = (await gitBranches(root)).find((b) => b.remote === null && b.name === name)
  if (!branch) throw new GitError(`A branch "${name}" não existe.`, null, '')
  return branch
}

// Sem `force`, o git só apaga o que já está mesclado no upstream (ou no HEAD); o resto volta como
// 'not-merged' para a interface pedir a confirmação forte e chamar de novo com `force`.
export async function gitDeleteBranch(root: string, name: string, force: boolean): Promise<GitBranchDeleteResult> {
  const branch = await localBranch(root, name)
  if (branch.current) throw new GitError(`"${name}" é a branch atual. Troque para outra antes de apagar.`, null, '')
  try {
    await runGit(root, ['branch', force ? '-D' : '-d', name])
    return 'deleted'
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    if (!force && /not fully merged/i.test(err.stderr)) return 'not-merged'
    if (/checked out at|used by worktree/i.test(err.stderr)) {
      throw new GitError(`A branch "${name}" está aberta em outra worktree. Troque de branch lá ou remova a worktree antes.`, err.exitCode, err.stderr)
    }
    throw new GitError(`Não foi possível apagar a branch "${name}": ${err.message}`, err.exitCode, err.stderr)
  }
}

export async function gitRenameBranch(root: string, from: string, to: string): Promise<void> {
  await localBranch(root, from)
  await assertBranchName(root, to)
  if (from === to) return
  try {
    await runGit(root, ['branch', '-m', from, to])
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    if (/already exists/i.test(err.stderr)) throw new GitError(`Já existe uma branch "${to}".`, err.exitCode, err.stderr)
    throw new GitError(`Não foi possível renomear a branch "${from}": ${err.message}`, err.exitCode, err.stderr)
  }
}

// "Publicar branch" do menu: envia uma branch local (não precisa ser a atual) e passa a rastrear o remoto.
export async function gitPublishBranch(root: string, name: string): Promise<void> {
  const branch = await localBranch(root, name)
  if (branch.upstream) throw new GitError(`A branch "${name}" já está publicada em ${branch.upstream}.`, null, '')
  const remote = await publishRemote(root)
  await withHint('O Push falhou', () =>
    runGit(root, ['push', '-u', remote, `refs/heads/${name}:refs/heads/${name}`], { timeoutMs: NETWORK_TIMEOUT_MS })
  )
}
