import { useState } from 'react'
import { Icon, type IconName } from '@/brand/icons'
import type { Project } from '@shared/state'
import type { SessionSummary } from '@shared/ipc'
import type { GitCommitResult } from '@shared/git-types'
import type { AgentActivity, AgentSession } from '@shared/agent'
import { FileTree } from '@/components/FileTree'
import { SessionsPanel } from '@/components/SessionsPanel'
import { GitPanel } from '@/components/GitPanel'
import { MetricsPanel } from '@/components/MetricsPanel'
import { useGit } from '@/lib/use-git'
import { cn } from '@/lib/utils'

type View = 'files' | 'git' | 'sessions' | 'metrics'

// O painel é recriado a cada troca de projeto; a aba escolhida fica guardada para não voltar a Arquivos.
const VIEW_KEY = 'kora.painelDireito.aba'
const isView = (value: unknown): value is View => value === 'files' || value === 'git' || value === 'sessions' || value === 'metrics'

function readView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    return isView(saved) ? saved : 'files'
  } catch {
    return 'files'
  }
}

// Métricas fica só com o ícone: quatro rótulos não cabem na largura do painel.
const VIEWS: { view: View; title: string; icon: IconName; iconOnly?: boolean }[] = [
  { view: 'files', title: 'Arquivos', icon: 'arquivo' },
  { view: 'git', title: 'Git', icon: 'git' },
  { view: 'sessions', title: 'Sessões', icon: 'sessoes' },
  { view: 'metrics', title: 'Métricas da sessão', icon: 'metricas', iconOnly: true }
]

interface Props {
  project: Project
  missing: boolean
  // Conversas com aba aberta e o nome dado a essa aba (null: aba sem nome do usuário).
  openSessions: Map<string, string | null>
  onOpenFile(path: string): void
  onOpenDiff(path: string, staged: boolean): void
  // Mensagem do commit guardada fora do painel, que é recriado a cada troca de projeto.
  commitDraft: string
  onCommitDraftChange(update: (current: string) => string): void
  onOpenSession(session: SessionSummary): void
  onPinSession(session: SessionSummary): void
  onOpenWorktree(path: string): void
  onPathMoved(from: string, to: string): void
  hasUnsavedUnder(rel: string): boolean
  reveal: { path: string; n: number } | null
  // Agente e estado da aba ativa, para as métricas.
  activeAgent: AgentSession | null
  activeActivity: AgentActivity | null
}

export function RightPanel(props: Props): React.JSX.Element {
  const [view, setViewState] = useState<View>(readView)
  const setView = (next: View): void => {
    setViewState(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Sem armazenamento o painel só volta para Arquivos na próxima troca de projeto.
    }
  }
  const [reloadKey, setReloadKey] = useState(0)
  const [collapseAll, setCollapseAll] = useState(0)
  const git = useGit(props.project.id, reloadKey, view === 'git')
  const id = props.project.id

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-background">
      <div className="window-drag flex h-10 shrink-0 items-center gap-2 border-b pl-3 pr-[calc(var(--window-controls-width)+0.5rem)]">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" data-tip={props.project.path}>
          {props.project.name}
        </span>
        {view === 'files' && !props.missing && (
          <button
            type="button"
            data-tip="Recolher pastas"
            aria-label="Recolher pastas"
            onClick={() => setCollapseAll((n) => n + 1)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Icon name="recolher" className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          data-tip="Recarregar"
          aria-label="Recarregar"
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Icon name="atualizar" className="size-3.5" />
        </button>
      </div>

      {props.missing ? (
        <p data-missing-folder className="px-3 py-3 text-xs text-muted-foreground">
          Sem a pasta do projeto não há arquivos, git nem sessões para mostrar.
        </p>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
            {VIEWS.map(({ view: v, title, icon, iconOnly }) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                data-tip={iconOnly ? title : undefined}
                aria-label={iconOnly ? title : undefined}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-secondary',
                  iconOnly ? 'flex-none' : 'flex-1',
                  view === v ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon name={icon} active={view === v} className="size-3.5" />
                {!iconOnly && title}
              </button>
            ))}
          </div>
          <div className="h-1.5 shrink-0" />

          {view === 'files' && (
            <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              <FileTree
                projectId={props.project.id}
                projectPath={props.project.path}
                reloadKey={reloadKey}
                gitFiles={git.status?.isRepo ? git.status.files : []}
                onOpenFile={props.onOpenFile}
                onPathMoved={props.onPathMoved}
                hasUnsavedUnder={props.hasUnsavedUnder}
                reveal={props.reveal}
                collapseAll={collapseAll}
              />
            </div>
          )}
          {view === 'git' && (
            <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              <GitPanel
                status={git.status}
                branches={git.branches}
                worktrees={git.worktrees}
                loading={git.loading}
                busy={git.busy}
                error={git.error}
                onRefresh={git.refresh}
                onCreateBranch={(name, checkout) => void git.run(() => window.kora.gitCreateBranch(id, name, checkout))}
                onCheckout={(name, remote) => void git.run(() => window.kora.gitCheckout(id, name, remote))}
                remote={git.remote}
                onInit={() => void git.run(() => window.kora.gitInit(id))}
                onSetRemote={(url) => void git.run(() => window.kora.gitSetRemote(id, url))}
                onOpenFile={props.onOpenFile}
                onOpenDiff={props.onOpenDiff}
                onOpenWorktree={props.onOpenWorktree}
                onStage={(paths) => void git.run(() => window.kora.gitStage(id, paths), 'Colocando na fila…')}
                onUnstage={(paths) => void git.run(() => window.kora.gitUnstage(id, paths), 'Tirando da fila…')}
                onDiscard={(paths) => void git.run(() => window.kora.gitDiscard(id, paths), 'Descartando…')}
                commitMessage={props.commitDraft}
                onCommitMessageChange={(message) => props.onCommitDraftChange(() => message)}
                onCommit={async (message, stageAll) => {
                  let result: GitCommitResult | null = null
                  const ok = await git.run(async () => {
                    result = await window.kora.gitCommit(id, message, stageAll)
                  }, 'Commitando…')
                  // Só limpa se a mensagem não mudou enquanto o commit rodava.
                  if (result === 'committed') props.onCommitDraftChange((current) => (current === message ? '' : current))
                  return ok ? result : null
                }}
                onPush={() => void git.run(() => window.kora.gitPush(id), 'Enviando (Push)…')}
                onPull={() => void git.run(() => window.kora.gitPull(id), 'Trazendo (Pull)…')}
                onSync={() => void git.run(() => window.kora.gitSync(id), 'Sincronizando…')}
                onFetch={() => void git.run(() => window.kora.gitFetch(id), 'Buscando do remoto…')}
              />
            </div>
          )}
          {view === 'metrics' && (
            <MetricsPanel projectId={props.project.id} agent={props.activeAgent} activity={props.activeActivity} />
          )}
          {view === 'sessions' && (
            <SessionsPanel
              projectId={props.project.id}
              reloadKey={reloadKey}
              openSessions={props.openSessions}
              onOpen={props.onOpenSession}
              onPin={props.onPinSession}
            />
          )}
        </>
      )}
    </aside>
  )
}
