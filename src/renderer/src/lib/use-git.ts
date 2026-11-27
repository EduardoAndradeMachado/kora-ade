import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitBranch, GitStatus, GitWorktree } from '@shared/git-types'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { notifyGitChanged } from '@/lib/git-refresh'

const POLL_MS = 5000
// Salvar em sequência (agente editando vários arquivos) gera um aviso atrás do outro; um status por segundo basta.
const CHANGE_THROTTLE_MS = 1000
const PENDING_HEAD = '(aguardando o status)'

// Atualização automática (polling, foco, watcher) é silenciosa: não gira o botão nem desabilita as linhas, e só
// toca o estado se o git respondeu algo diferente. Com milhares de arquivos alterados, um render à toa do painel
// (e da árvore de arquivos ao lado) custa caro.
function keepIfSame<T, P extends T | null>(next: T): (prev: P) => T | P {
  const text = JSON.stringify(next)
  return (prev) => (JSON.stringify(prev) === text ? prev : next)
}

export interface GitState {
  status: GitStatus | null
  branches: GitBranch[]
  worktrees: GitWorktree[]
  remote: string | null
  loading: boolean
  // Ação do usuário em andamento (commit, push…), separada do `loading` do polling: os botões não podem
  // piscar desabilitados a cada atualização automática.
  busy: string | null
  error: string | null
  // Atualizar pedido pelo usuário: também tira da tela o erro da última ação.
  refresh(): void
  // true se deu certo; o erro fica em `error`.
  run(action: () => Promise<unknown>, busyLabel?: string): Promise<boolean>
}

// O Claude/Codex mexem no repositório o tempo todo: o aviso do watcher atualiza na hora, e o polling
// cobre o que ele não vê (ex.: commit feito fora, com a janela sem foco).
export function useGit(projectId: string, reloadKey: number, withBranches: boolean): GitState {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [remote, setRemote] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Separados: a atualização automática (polling, foco, watcher) só limpa o próprio erro. Se limpasse o da
  // ação, o motivo de um Push recusado sumiria da tela em até 5 s.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Só a leitura mais recente vale: troca de projeto ou leitura nova descarta a resposta das anteriores.
  const latestLoad = useRef(0)
  // Depois de um erro de ação o próximo status precisa chegar como objeto novo, mesmo igual: é ele que vira a
  // referência do PENDING_HEAD.
  const forceStatus = useRef(false)

  // Fora do estado do React de propósito: um contador em estado renderizava o painel a cada 5 s mesmo sem mudança.
  const load = useCallback(
    (quiet: boolean): void => {
      const id = ++latestLoad.current
      const current = (): boolean => id === latestLoad.current
      if (!quiet) setLoading(true)
      const jobs: Promise<unknown>[] = [
        window.kora.gitStatus(projectId).then((s) => current() && setStatus(forceStatus.current ? s : keepIfSame(s))),
        window.kora.gitRemoteUrl(projectId).then((r) => current() && setRemote(r))
      ]
      if (withBranches) {
        jobs.push(window.kora.gitBranches(projectId).then((b) => current() && setBranches(keepIfSame(b))))
        jobs.push(window.kora.gitWorktrees(projectId).then((w) => current() && setWorktrees(keepIfSame(w))))
      }
      Promise.all(jobs).then(
        () => current() && setLoadError(null),
        (err: unknown) => current() && setLoadError(ipcErrorMessage(err))
      ).finally(() => current() && setLoading(false))
    },
    [projectId, withBranches]
  )
  const refresh = useCallback(() => load(true), [load])
  // As ações terminam depois de um await: se o projeto trocou no meio, a leitura é a do projeto atual.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    load(false)
    return () => {
      latestLoad.current++
    }
  }, [load, reloadKey])

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

  // Erro de ação que ficou para trás: o HEAD mudou depois dele (troca de branch, commit, merge feito no terminal ou
  // por um agente) e o motivo não vale mais. A referência é o primeiro status lido depois do erro, porque a própria
  // ação pode ter mudado o HEAD antes de falhar (trocou de branch, mas não reaplicou o stash).
  const [errorHead, setErrorHead] = useState<string | null>(null)
  const head = status?.isRepo ? `${status.branch}\0${status.oid}\0${status.operation?.kind ?? ''}` : ''
  useEffect(() => {
    if (errorHead === PENDING_HEAD) {
      forceStatus.current = false
      setErrorHead(head)
    }
    else if (errorHead !== null && head !== errorHead) {
      setErrorHead(null)
      setActionError(null)
    }
    // Cada status novo conta, mesmo com o mesmo HEAD: é assim que o PENDING_HEAD vira referência.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const run = async (action: () => Promise<unknown>, busyLabel = 'Aguarde…'): Promise<boolean> => {
    setLoading(true)
    setBusy(busyLabel)
    setActionError(null)
    try {
      await action()
      loadRef.current(false)
      notifyGitChanged(projectId)
      return true
    } catch (err) {
      setActionError(ipcErrorMessage(err))
      setErrorHead(PENDING_HEAD)
      forceStatus.current = true
      loadRef.current(false)
      return false
    } finally {
      setBusy(null)
    }
  }

  const userRefresh = (): void => {
    setActionError(null)
    load(false)
  }

  return { status, branches, worktrees, remote, loading, busy, error: actionError ?? loadError, refresh: userRefresh, run }
}
