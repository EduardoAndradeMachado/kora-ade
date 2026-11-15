import { useEffect, useState } from 'react'
import { Icon, type IconName } from '@/brand/icons'
import type { Project } from '@shared/state'
import type { SessionSummary } from '@shared/ipc'
import type { GitCommitResult } from '@shared/git-types'
import type { GitDiffOpen, OpenAtOptions, OpenFileOptions } from '@/lib/file-tabs'
import type { AgentActivity, AgentSession } from '@shared/agent'
import { FileTree } from '@/components/FileTree'
import { SessionsPanel } from '@/components/SessionsPanel'
import { GitPanel } from '@/components/GitPanel'
import { MetricsPanel } from '@/components/MetricsPanel'
import { SearchPanel, selectionSeed, type SearchRequest } from '@/components/SearchPanel'
import { useGit } from '@/lib/use-git'
import { useConflictFlows } from '@/components/git/ConflictFlows'
import { ConflictBanner } from '@/components/git/ConflictBanner'
import { StashSection } from '@/components/git/StashSection'
import { cn } from '@/lib/utils'

type View = 'files' | 'git' | 'sessions' | 'metrics'

// O painel é recriado a cada troca de projeto; a aba escolhida fica guardada para não voltar a Arquivos.
const VIEW_KEY = 'kora.painelDireito.aba'
const isView = (value: unknown): value is View => value === 'files' || value === 'git' || value === 'sessions' || value === 'metrics'

function readView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    // 'search' foi uma aba própria; a busca agora fica dentro de Arquivos.
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
  onOpenFile(path: string, opts?: OpenFileOptions): void
  // Resultado da busca: preview no clique simples, fixa no duplo clique e no Enter.
  onOpenAt(rel: string, line: number | null, opts?: OpenAtOptions): void
  onOpenDiff(path: string, staged: boolean, opts?: GitDiffOpen): void
  onCompare(left: string, right: string): void
  onOpenTerminal(dir: string): void
  // Mensagem do commit guardada fora do painel, que é recriado a cada troca de projeto.
  commitDraft: string
  onCommitDraftChange(update: (current: string) => string): void
  onOpenSession(session: SessionSummary): void
  onPinSession(session: SessionSummary): void
  onOpenWorktree(path: string): void
  onPathMoved(from: string, to: string): void
  hasUnsavedUnder(rel: string): boolean
  reveal: { path: string; n: number; show?: boolean } | null
  onRevealShown(): void
  // Ctrl+Shift+F (tratado no App, que também abre o painel se estiver fechado).
  searchRequested: boolean
  onSearchShown(): void
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
  const flows = useConflictFlows({
    projectId: props.project.id,
    git,
    commitDraft: props.commitDraft,
    onCommitDraftChange: props.onCommitDraftChange
  })
  const id = props.project.id
  // A busca é um modo de Arquivos (os resultados tomam o lugar da árvore). O texto e os resultados ficam
  // guardados no SearchPanel por projeto, então fechar e reabrir não perde nada.
  const [searching, setSearching] = useState(false)
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null)
  const showSearch = (request: Omit<SearchRequest, 'n'> = {}): void => {
    setView('files')
    setSearching(true)
    setSearchRequest((r) => ({ ...request, n: (r?.n ?? 0) + 1 }))
  }

  useEffect(() => {
    if (!props.searchRequested) return
    props.onSearchShown()
    setView('files')
    setSearching(true)
    // selectionSeed pega o elemento com foco já aqui; o campo só recebe o foco quando o pedido chega ao SearchPanel.
    void selectionSeed()
      .catch(() => undefined)
      .then((query) => showSearch({ query }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.searchRequested])

  useEffect(() => {
    if (!props.reveal?.show) return
    setView('files')
    setSearching(false)
    props.onRevealShown()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.show])

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-background">
      <div className="window-drag flex h-10 shrink-0 items-center gap-2 border-b pl-3 pr-[calc(var(--window-controls-width)+0.5rem)]">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" data-tip={props.project.path}>
          {props.project.name}
        </span>
        {view === 'files' && !searching && !props.missing && (
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
          <div className="flex shrink-0 items-center gap-0.5 border-b px-1.5 py-1.5">
            {VIEWS.map(({ view: v, title, icon, iconOnly }) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                data-tip={iconOnly ? title : undefined}
                aria-label={iconOnly ? title : undefined}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md py-1 text-xs hover:bg-secondary',
                  // Com o zoom da interface alto, os rótulos encolhem com reticências em vez de empurrar Métricas para fora.
                  iconOnly ? 'flex-none px-1.5' : 'min-w-0 flex-auto px-2',
                  view === v ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon name={icon} active={view === v} className="size-3.5 shrink-0" />
                {!iconOnly && <span className="truncate">{title}</span>}
              </button>
            ))}
          </div>
          <div className="h-1.5 shrink-0" />

          {view === 'files' && !searching && (
            <button
              type="button"
              onClick={() => showSearch()}
              data-tip="Buscar texto em todos os arquivos do projeto"
              data-tip-shortcut="Ctrl+Shift+F"
              className="mx-2 mb-1.5 flex shrink-0 items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-left text-xs text-muted-foreground hover:border-ring hover:text-foreground"
            >
              <Icon name="buscar" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Buscar nos arquivos</span>
              <span className="shrink-0 text-[10px] opacity-70">Ctrl+Shift+F</span>
            </button>
          )}
          {view === 'files' && !searching && (
            <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              <FileTree
                projectId={props.project.id}
                projectPath={props.project.path}
                reloadKey={reloadKey}
                gitFiles={git.status?.isRepo ? git.status.files : []}
                isGitRepo={git.status?.isRepo === true}
                onOpenFile={props.onOpenFile}
                onPathMoved={props.onPathMoved}
                hasUnsavedUnder={props.hasUnsavedUnder}
                reveal={props.reveal}
                collapseAll={collapseAll}
                onCompare={props.onCompare}
                onOpenTerminal={props.onOpenTerminal}
                // VS Code "Buscar na pasta…": a pasta vai ancorada na raiz para não pegar homônimas em outro nível.
                onSearchIn={(dir) => showSearch({ include: dir ? `.\\${dir}` : '' })}
              />
            </div>
          )}
          {view === 'files' && searching && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <SearchPanel projectId={id} request={searchRequest} reloadKey={reloadKey} onOpenAt={props.onOpenAt} onClose={() => setSearching(false)} />
            </div>
          )}
          {view === 'git' && (
            <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              <GitPanel
                projectId={id}
                projectPath={props.project.path}
                run={git.run}
                status={git.status}
                branches={git.branches}
                worktrees={git.worktrees}
                loading={git.loading}
                busy={git.busy}
                error={git.error}
                onRefresh={git.refresh}
                onCreateBranch={(name, checkout) => void git.run(() => window.kora.gitCreateBranch(id, name, checkout))}
                onCheckout={flows.checkout}
                remote={git.remote}
                onInit={() => void git.run(() => window.kora.gitInit(id))}
                onSetRemote={(url) => void git.run(() => window.kora.gitSetRemote(id, url))}
                onOpenFile={props.onOpenFile}
                onOpenDiff={props.onOpenDiff}
                onOpenWorktree={props.onOpenWorktree}
                onStage={flows.stage}
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
                onPush={flows.push}
                onPull={flows.pull}
                onSync={flows.sync}
                operationBanner={
                  <ConflictBanner status={git.status} disabled={git.busy !== null} onAbort={flows.abort} onContinue={flows.continueOperation} />
                }
                stashSection={<StashSection projectId={id} status={git.status} git={git} />}
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
      {flows.dialog}
    </aside>
  )
}
