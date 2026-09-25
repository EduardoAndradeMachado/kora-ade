import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@/brand/icons'
import { Loader } from '@/brand/Logo'
import type { SessionSummary } from '@shared/ipc'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/components/ConfirmDialog'
import { ipcErrorMessage } from '@/lib/ipc-error'

interface Props {
  projectId: string
  reloadKey: number
  openSessions: Map<string, string | null>
  onOpen(session: SessionSummary): void
  onPin(session: SessionSummary): void
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  if (d === 1) return 'ontem'
  if (d < 7) return `há ${d} dias`
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function SessionsPanel({ projectId, reloadKey, openSessions, onOpen, onPin }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const confirm = useConfirm()

  const remove = async (session: SessionSummary): Promise<void> => {
    const ok = await confirm({
      title: `Apagar a conversa "${session.title}"?`,
      message: `Os arquivos dela vão para a Lixeira do Windows (dá para restaurar por lá). O ${agentLabel(session.kind)} deixa de listar e de retomar essa conversa.`,
      confirmLabel: 'Apagar conversa',
      danger: true
    })
    if (!ok) return
    try {
      await window.kora.deleteSession(projectId, session)
      setNotice(null)
      setSessions((prev) => prev?.filter((s) => !(s.kind === session.kind && s.sessionId === session.sessionId)) ?? prev)
    } catch (err) {
      setNotice(ipcErrorMessage(err))
    }
  }

  useEffect(() => {
    let cancelled = false
    window.kora.listSessions(projectId).then(
      (list) => !cancelled && (setSessions(list), setError(null)),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      cancelled = true
    }
  }, [projectId, reloadKey])

  // Conversa com aba aberta mostra o nome atual da aba: o main só grava o nome depois do save das abas.
  const named = useMemo(
    () =>
      (sessions ?? []).map((s): SessionSummary => {
        if (!openSessions.has(s.sessionId)) return s
        const tabName = openSessions.get(s.sessionId)
        return tabName ? { ...s, title: tabName, named: true } : { ...s, title: s.agentTitle ?? s.title, named: false }
      }),
    [sessions, openSessions]
  )

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return named
    return named.filter((s) => s.title.toLowerCase().includes(q) || s.sessionId.startsWith(q))
  }, [named, filter])

  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>
  if (!sessions) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader size={18} />
        Lendo conversas…
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrar conversas"
          className="w-full rounded-md border bg-card px-2 py-1 text-xs outline-none select-text focus:border-ring"
        />
      </div>
      {notice && <p className="px-3 pb-2 text-xs text-destructive">{notice}</p>}
      {sessions.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Nenhuma conversa do Claude ou do Codex nesta pasta ainda.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {visible.map((s) => {
          const open = openSessions.has(s.sessionId)
          return (
            <div
              key={`${s.kind}:${s.sessionId}`}
              title={`${agentLabel(s.kind)} · ${s.sessionId}\n${open ? 'Já está numa aba — clique para ir até ela' : 'Clique para abrir e continuar'}`}
              onClick={() => onOpen(s)}
              className="group flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/60"
            >
              <AgentIcon kind={s.kind} className="mt-0.5 size-3.5" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={cn('truncate text-xs', open ? 'text-foreground' : 'text-foreground/90')}>{s.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {relativeTime(s.updatedAt)}
                  {open && ' · aberta numa aba'}
                </span>
              </div>
              {!open && (
                <div className="hidden items-center gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    title="Fixar como aba sem abrir agora"
                    onClick={(e) => {
                      e.stopPropagation()
                      onPin(s)
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Icon name="fixar" className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Apagar conversa"
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(s)
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                  >
                    <Icon name="excluir" className="size-3.5" />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
