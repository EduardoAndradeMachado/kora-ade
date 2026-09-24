import { useState } from 'react'
import { Icon, type IconName } from '@/brand/icons'
import type { Project } from '@shared/state'
import type { SessionSummary } from '@shared/ipc'
import { FileTree } from '@/components/FileTree'
import { SessionsPanel } from '@/components/SessionsPanel'
import { GitPanel } from '@/components/GitPanel'
import { useGit } from '@/lib/use-git'
import { cn } from '@/lib/utils'

type View = 'files' | 'git' | 'sessions'

const VIEWS: { view: View; title: string; icon: IconName }[] = [
  { view: 'files', title: 'Arquivos', icon: 'arquivo' },
  { view: 'git', title: 'Git', icon: 'git' },
  { view: 'sessions', title: 'Sessões', icon: 'sessoes' }
]

interface Props {
  project: Project
  openSessionIds: Set<string>
  onOpenFile(path: string): void
  onOpenSession(session: SessionSummary): void
  onPinSession(session: SessionSummary): void
  onOpenWorktree(path: string): void
  onPathMoved(from: string, to: string): void
  hasUnsavedUnder(rel: string): boolean
  reveal: { path: string; n: number } | null
}

export function RightPanel(props: Props): React.JSX.Element {
  const [view, setView] = useState<View>('files')
  const [reloadKey, setReloadKey] = useState(0)
  const git = useGit(props.project.id, reloadKey, view === 'git')

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-background">
      <div className="window-drag flex h-10 shrink-0 items-center gap-2 border-b pl-3 pr-[calc(var(--window-controls-width)+0.5rem)]">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={props.project.path}>
          {props.project.name}
        </span>
        <button
          type="button"
          title="Recarregar"
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Icon name="atualizar" className="size-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        {VIEWS.map(({ view: v, title, icon }) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-secondary',
              view === v ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon name={icon} active={view === v} className="size-3.5" />
            {title}
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
            error={git.error}
            onRefresh={git.refresh}
            onCreateBranch={(name, checkout) => git.run(() => window.kora.gitCreateBranch(props.project.id, name, checkout))}
            onCheckout={(name, remote) => git.run(() => window.kora.gitCheckout(props.project.id, name, remote))}
            remote={git.remote}
            onInit={() => git.run(() => window.kora.gitInit(props.project.id))}
            onSetRemote={(url) => git.run(async () => void (await window.kora.gitSetRemote(props.project.id, url)))}
            onOpenFile={props.onOpenFile}
            onOpenWorktree={props.onOpenWorktree}
          />
        </div>
      )}
      {view === 'sessions' && (
        <SessionsPanel
          projectId={props.project.id}
          reloadKey={reloadKey}
          openSessionIds={props.openSessionIds}
          onOpen={props.onOpenSession}
          onPin={props.onPinSession}
        />
      )}
    </aside>
  )
}
