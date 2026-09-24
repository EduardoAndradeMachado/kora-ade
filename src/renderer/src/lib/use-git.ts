import { useCallback, useEffect, useState } from 'react'
import type { GitBranch, GitStatus, GitWorktree } from '@shared/git-types'
import { ipcErrorMessage } from '@/lib/ipc-error'

const POLL_MS = 5000
// Salvar em sequência (agente editando vários arquivos) gera um aviso atrás do outro; um status por segundo basta.
const CHANGE_THROTTLE_MS = 1000

export interface GitState {
  status: GitStatus | null
  branches: GitBranch[]
  worktrees: GitWorktree[]
  remote: string | null
  loading: boolean
  error: string | null
  refresh(): void
  run(action: () => Promise<void>): void
}

// O Claude/Codex mexem no repositório o tempo todo: o aviso do watcher atualiza na hora, e o polling
// cobre o que ele não vê (ex.: commit feito fora, com a janela sem foco).
export function useGit(projectId: string, reloadKey: number, withBranches: boolean): GitState {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [remote, setRemote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const jobs: Promise<unknown>[] = [
      window.kora.gitStatus(projectId).then((s) => !cancelled && setStatus(s)),
      window.kora.gitRemoteUrl(projectId).then((r) => !cancelled && setRemote(r))
    ]
    if (withBranches) {
      jobs.push(window.kora.gitBranches(projectId).then((b) => !cancelled && setBranches(b)))
      jobs.push(window.kora.gitWorktrees(projectId).then((w) => !cancelled && setWorktrees(w)))
    }
    Promise.all(jobs).then(
      () => !cancelled && setError(null),
      (err: unknown) => !cancelled && setError(ipcErrorMessage(err))
    ).finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [projectId, reloadKey, tick, withBranches])

  useEffect(() => {
    let last = 0
    let trailing: ReturnType<typeof setTimeout> | undefined
    const off = window.kora.onFilesChanged((changedProject, change) => {
      if (changedProject !== projectId || !change.git) return
      const wait = last + CHANGE_THROTTLE_MS - Date.now()
      if (wait <= 0) {
        last = Date.now()
        refresh()
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = undefined
          last = Date.now()
          refresh()
        }, wait)
      }
    })
    return () => {
      off()
      clearTimeout(trailing)
    }
  }, [projectId, refresh])

  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const run = (action: () => Promise<void>): void => {
    setLoading(true)
    action().then(
      () => refresh(),
      (err: unknown) => {
        setError(ipcErrorMessage(err))
        setLoading(false)
      }
    )
  }

  return { status, branches, worktrees, remote, loading, error, refresh, run }
}
