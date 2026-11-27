import { useEffect, useState } from 'react'
import { Icon, type IconName } from '@/brand/icons'
import type {
  GitBranch,
  GitBranchDeleteResult,
  GitCommitResult,
  GitFile,
  GitFileStatus,
  GitHeadCommit,
  GitStatus,
  GitWorktree
} from '@shared/git-types'
import { cn } from '@/lib/utils'
import { Button } from '@/brand/Button'
import { useConfirm } from '@/components/ConfirmDialog'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { HistorySection } from '@/components/git/HistorySection'
import { GitErrorNotice } from '@/components/git/GitErrorNotice'
import { VirtualRows } from '@/components/VirtualRows'
import { GIT_STYLE } from '@/lib/git-decorations'
import { copyPath } from '@/lib/copied-path'
import { ipcErrorMessage } from '@/lib/ipc-error'
import type { GitDiffOpen } from '@/lib/file-tabs'

interface Props {
  projectId: string
  projectPath: string
  status: GitStatus | null
  branches: GitBranch[]
  worktrees: GitWorktree[]
  loading: boolean
  busy: string | null
  error: string | null
  onRefresh(): void
  onCreateBranch(name: string, checkout: boolean): void
  onCheckout(name: string, remote: string | null): void
  // preview: clique simples (aba de pré-visualização); sem ele, a aba fica fixa (duplo clique, menu).
  onOpenFile(path: string, opts?: { preview?: boolean }): void
  onOpenDiff(path: string, staged: boolean, opts?: GitDiffOpen): void
  onOpenWorktree(path: string): void
  remote: string | null
  onInit(): void
  onSetRemote(url: string): void
  onStage(paths: string[]): void
  onUnstage(paths: string[]): void
  onDiscard(paths: string[]): void
  commitMessage: string
  onCommitMessageChange(message: string): void
  // null: falhou (o erro aparece no painel).
  onCommit(message: string, stageAll: boolean): Promise<GitCommitResult | null>
  onPush(): void
  onPull(): void
  onSync(): void
  onFetch(): void
  // Ações que o painel chama direto (histórico, branches, .gitignore, corrigir/desfazer commit): o `run` do
  // useGit mostra o andamento, guarda o erro e atualiza o status no fim. true se deu certo.
  run(action: () => Promise<unknown>, busyLabel?: string): Promise<boolean>
  // Merge/rebase em andamento (topo do painel) e a seção de stash, montados pelo dono dos fluxos de conflito.
  operationBanner?: React.ReactNode
  stashSection?: React.ReactNode
}

const shortRemote = (url: string): string => url.replace(/^(https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '')

// Remoto SSH (git@host:dono/repo.git) também tem página web: a mesma URL em https.
function remoteWebUrl(remote: string): string | null {
  const ssh = /^git@([^:/]+):(.+)$/.exec(remote) ?? /^ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+)$/.exec(remote)
  try {
    const url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : remote)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    url.username = ''
    url.password = ''
    url.pathname = url.pathname.replace(/\.git$/, '')
    return url.toString()
  } catch {
    return null
  }
}

function RemoteRow({ remote, onSave }: { remote: string | null; onSave(url: string): void }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    const webUrl = remote ? remoteWebUrl(remote) : null
    return (
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b px-3 text-[11px] text-muted-foreground">
        <Icon name="externo" className="size-3 shrink-0" />
        {remote ? (
          <>
            {webUrl ? (
              <a
                href={webUrl}
                target="_blank"
                rel="noreferrer"
                data-tip="Abrir no navegador"
                data-tip-detail={webUrl}
                className="min-w-0 flex-1 truncate hover:text-foreground hover:underline"
              >
                origin · {shortRemote(remote)}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate" data-tip={remote}>
                origin · {shortRemote(remote)}
              </span>
            )}
            <button type="button" onClick={() => setDraft(remote)} className="rounded px-1 hover:bg-secondary hover:text-foreground">
              Trocar
            </button>
          </>
        ) : (
          <>
            <span className="flex-1">Sem repositório remoto</span>
            <button type="button" onClick={() => setDraft('')} className="rounded px-1 font-medium text-foreground hover:bg-secondary">
              Vincular ao GitHub
            </button>
          </>
        )}
      </div>
    )
  }
  const save = (): void => {
    if (draft.trim()) onSave(draft.trim())
    setDraft(null)
  }
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setDraft(null)
        }}
        placeholder="https://github.com/dono/repositorio"
        className="min-w-0 flex-1 rounded-md border bg-card px-2 py-1 text-xs outline-none select-text focus:border-ring"
      />
      <Button onClick={save} className="px-2.5 py-1">
        Salvar
      </Button>
    </div>
  )
}

// Letra e cor vêm das decorações da árvore de arquivos: o mesmo status tem a mesma cara nos dois painéis.
const STATUS_LABEL: Record<GitFileStatus, string> = {
  modified: 'Modificado',
  added: 'Adicionado',
  untracked: 'Não rastreado',
  deleted: 'Excluído',
  renamed: 'Renomeado',
  conflicted: 'Conflito'
}

// "Na fila" em todo o painel (e nos títulos das abas de diff), no lugar do "Staged"/"Preparadas" do VS Code.
const FILE_GROUPS: { id: string; title: string; match(file: GitFile): boolean }[] = [
  { id: 'files:conflicts', title: 'Conflitos', match: (f) => f.status === 'conflicted' },
  { id: 'files:staged', title: 'Na fila', match: (f) => f.staged && f.status !== 'conflicted' },
  {
    id: 'files:changes',
    title: 'Alterações',
    match: (f) => !f.staged && f.status !== 'untracked' && f.status !== 'conflicted'
  },
  { id: 'files:untracked', title: 'Não rastreados', match: (f) => f.status === 'untracked' }
]

// Altura da classe h-6 do ROW: a lista virtual de arquivos depende dela.
const ROW_HEIGHT = 24
const ROW = 'flex h-6 cursor-default items-center gap-1.5 rounded pr-2 text-xs hover:bg-secondary/60'

function splitPath(path: string): { name: string; dir: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? { name: path, dir: '' } : { name: path.slice(cut + 1), dir: path.slice(0, cut) }
}

function AheadBehind({ ahead, behind }: { ahead: number; behind: number }): React.JSX.Element | null {
  if (ahead === 0 && behind === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      {ahead > 0 && (
        <span className="flex items-center">
          <Icon name="setaCima" className="size-3" />
          {ahead}
        </span>
      )}
      {behind > 0 && (
        <span className="flex items-center">
          <Icon name="setaBaixo" className="size-3" />
          {behind}
        </span>
      )}
    </span>
  )
}

interface RowAction {
  label: string
  icon: IconName
  danger?: boolean
  run(): void
}

// Ações da linha aparecem só com o mouse em cima, como no VS Code; o clique não chega na linha.
function RowActions({ actions, disabled }: { actions: RowAction[]; disabled: boolean }): React.JSX.Element | null {
  if (actions.length === 0) return null
  return (
    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          data-tip={action.label}
          aria-label={action.label}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation()
            action.run()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            'rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent',
            action.danger ? 'hover:text-destructive' : 'hover:text-foreground'
          )}
        >
          <Icon name={action.icon} className="size-3.5" />
        </button>
      ))}
    </span>
  )
}

function SectionHeader({
  title,
  count,
  open,
  depth = 0,
  actions = [],
  disabled = false,
  onToggle
}: {
  title: string
  count?: number
  open: boolean
  depth?: number
  actions?: RowAction[]
  disabled?: boolean
  onToggle(): void
}): React.JSX.Element {
  return (
    <div
      onClick={onToggle}
      style={{ paddingLeft: 4 + depth * 12 }}
      className={cn(
        ROW,
        'group gap-1 text-[11px] font-medium text-muted-foreground',
        depth === 0 && 'uppercase tracking-wide'
      )}
    >
      <Icon name="expandir" className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
      <span className="flex-1 truncate">{title}</span>
      <RowActions actions={actions} disabled={disabled} />
      {count !== undefined && <span className="rounded-full bg-secondary px-1.5 text-[10px] leading-4 normal-case">{count}</span>}
    </div>
  )
}

// Renomeado na fila só sai inteiro levando o caminho antigo junto (senão a exclusão do antigo fica na fila).
const pathsOf = (files: GitFile[]): string[] => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]))

// Não rastreado e conflito não têm diff útil com a fila: abrem o próprio arquivo, como no VS Code.
const opensAsFile = (file: GitFile): boolean => file.status === 'untracked' || file.status === 'conflicted'

// O HEAD tem o arquivo (no caminho antigo, se renomeado): não vale para não rastreado nem adicionado na fila.
const existsInHead = (file: GitFile): boolean => file.status !== 'untracked' && !(file.staged && file.status === 'added')

function FileRow({
  file,
  actions,
  disabled,
  onOpen,
  onMenu
}: {
  file: GitFile
  actions: RowAction[]
  disabled: boolean
  onOpen(file: GitFile, preview: boolean): void
  onMenu(e: React.MouseEvent, file: GitFile): void
}): React.JSX.Element {
  const { name, dir } = splitPath(file.path)
  const style = GIT_STYLE[file.status]
  const deleted = file.status === 'deleted'
  const click = opensAsFile(file) ? 'clique para abrir o arquivo' : 'clique para ver o diff'
  const title = `${file.origPath ? `${file.origPath} → ${file.path}` : file.path} — ${STATUS_LABEL[file.status]}\n${click} (duplo clique fixa a aba)`

  return (
    <div
      data-git-file={file.path}
      data-tip={title}
      onClick={() => onOpen(file, true)}
      onDoubleClick={() => onOpen(file, false)}
      onContextMenu={(e) => onMenu(e, file)}
      className={cn(ROW, 'group pl-4')}
    >
      <Icon name="arquivo" className={cn('size-3.5 shrink-0 text-muted-foreground', deleted && 'opacity-50')} />
      <span className={cn('min-w-0 truncate text-foreground', deleted && 'line-through opacity-70')}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
      <RowActions actions={actions} disabled={disabled} />
      <span className={cn('w-3 shrink-0 text-center font-mono text-[11px]', style.className)}>{style.letter}</span>
    </div>
  )
}

interface Amend {
  // O rascunho que estava na caixa antes de "Corrigir": volta quando a correção termina ou é cancelada.
  draft: string
  hash: string
  pushed: boolean
}

// Desabilitado em cinza com texto legível (o âmbar com opacidade 0,4 ficava ~2:1 no tema escuro).
const COMMIT_DISABLED = 'disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100 disabled:hover:brightness-100'

function CommitBox({
  message,
  disabled,
  canCommit,
  amend,
  onChange,
  onCommit,
  onMore,
  onCancelAmend
}: {
  message: string
  disabled: boolean
  canCommit: boolean
  amend: Amend | null
  onChange(message: string): void
  onCommit(): void
  onMore(e: React.MouseEvent): void
  onCancelAmend(): void
}): React.JSX.Element {
  const ready = !disabled && (canCommit || amend !== null) && message.trim() !== ''
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b px-2 py-2">
      {amend && (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1">
            Corrigindo o último commit ({amend.hash.slice(0, 7)}): leva a mensagem abaixo e o que estiver na fila.
            {amend.pushed && <span className="text-[#895503] dark:text-[#e2c08d]"> Ele já foi enviado: o próximo Push vai exigir force push.</span>}
          </span>
          <button type="button" onClick={onCancelAmend} className="shrink-0 rounded px-1 text-foreground hover:bg-secondary">
            Cancelar
          </button>
        </div>
      )}
      <textarea
        aria-label="Mensagem do commit"
        value={message}
        rows={Math.min(6, Math.max(2, message.split('\n').length))}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            if (ready) onCommit()
          }
          if (e.key === 'Escape' && amend) onCancelAmend()
        }}
        placeholder="Mensagem do commit (Ctrl+Enter)"
        spellCheck={false}
        className="w-full resize-none rounded-md border bg-card px-2 py-1.5 text-xs leading-relaxed outline-none select-text focus:border-ring"
      />
      <div className="flex">
        <Button
          disabled={!ready}
          onClick={onCommit}
          data-tip={amend ? 'Corrigir o último commit' : 'Commitar'}
          data-tip-detail={
            amend ? 'Refaz o último commit com esta mensagem e o que estiver na fila.' : 'Grava o que está na fila. Sem nada na fila, pergunta se coloca tudo.'
          }
          data-tip-shortcut="Ctrl+Enter"
          className={cn('min-w-0 flex-1 rounded-r-none py-1.5', COMMIT_DISABLED)}
        >
          <Icon name="ok" className="size-3.5" />
          {amend ? 'Corrigir commit' : 'Commitar'}
        </Button>
        <Button
          disabled={disabled}
          onClick={onMore}
          aria-label="Mais ações de commit"
          data-tip="Mais ações de commit"
          data-tip-detail="Corrigir o último commit ou desfazê-lo."
          className={cn('rounded-l-none border-l border-[var(--brand-ink)]/20 px-2 py-1.5', COMMIT_DISABLED)}
        >
          <Icon name="expandir" className="size-3 rotate-90" />
        </Button>
      </div>
    </div>
  )
}

const commits = (n: number): string => `${n} ${n === 1 ? 'commit' : 'commits'}`

const SYNC_BUTTON =
  'flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md bg-secondary px-1.5 text-[11px] text-foreground hover:bg-accent disabled:opacity-40 disabled:hover:bg-secondary'

function SyncRow({
  status,
  disabled,
  onPush,
  onPull,
  onSync,
  onFetch
}: {
  status: GitStatus
  disabled: boolean
  onPush(): void
  onPull(): void
  onSync(): void
  onFetch(): void
}): React.JSX.Element {
  const upstream = status.upstream
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b px-2 py-1.5">
      <div className="flex items-center gap-1">
        {upstream ? (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={onPull}
              data-tip="Pull"
              data-tip-detail={status.behind > 0 ? `Traz ${commits(status.behind)} de ${upstream}.` : `Nada novo em ${upstream}. Buscar confere se chegou algo.`}
              className={SYNC_BUTTON}
            >
              <Icon name="setaBaixo" className="size-3 shrink-0" />
              Pull
              {status.behind > 0 && <span className="font-semibold">{status.behind}</span>}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onPush}
              data-tip="Push"
              data-tip-detail={status.ahead > 0 ? `Envia ${commits(status.ahead)} para ${upstream}.` : `Nada para enviar a ${upstream}.`}
              className={SYNC_BUTTON}
            >
              <Icon name="setaCima" className="size-3 shrink-0" />
              Push
              {status.ahead > 0 && <span className="font-semibold">{status.ahead}</span>}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onSync}
              data-tip="Sincronizar"
              data-tip-detail={`Pull e depois Push com ${upstream}.`}
              className={SYNC_BUTTON}
            >
              <Icon name="sincronizar" className="size-3 shrink-0" />
              Sincronizar
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={onPush}
            data-tip="Publicar branch"
            data-tip-detail={`A branch "${status.branch}" ainda não existe no remoto. Envia para o origin e passa a acompanhá-lo.`}
            className={SYNC_BUTTON}
          >
            <Icon name="publicar" className="size-3.5 shrink-0" />
            Publicar branch
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={onFetch}
          aria-label="Buscar"
          data-tip="Buscar"
          data-tip-detail="Atualiza o que o remoto tem, sem mexer nos seus arquivos."
          className={cn(SYNC_BUTTON, 'w-7 flex-none px-0')}
        >
          <Icon name="buscarRemoto" className="size-3.5 shrink-0" />
        </button>
      </div>
    </div>
  )
}

function branchTitle(branch: GitBranch, action: string): string {
  const lines = [branch.upstream ? `${branch.name} → ${branch.upstream}` : branch.name]
  if (branch.lastCommit) lines.push(`${branch.lastCommit.subject} (${branch.lastCommit.relative})`)
  lines.push(action)
  return lines.join('\n')
}

function BranchRow({
  branch,
  label,
  depth,
  disabled,
  onCheckout,
  onMenu
}: {
  branch: GitBranch
  label: string
  depth: number
  disabled: boolean
  onCheckout(name: string, remote: string | null): void
  onMenu(e: React.MouseEvent, branch: GitBranch): void
}): React.JSX.Element {
  const action = branch.current
    ? 'Branch atual'
    : branch.remote
      ? `Clique para criar a branch local rastreando ${branch.name}`
      : 'Clique para trocar para esta branch'
  return (
    <div
      data-tip={branchTitle(branch, `${action} · botão direito para mais ações`)}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => {
        if (!branch.current && !disabled) onCheckout(branch.name, branch.remote)
      }}
      onContextMenu={(e) => onMenu(e, branch)}
      className={cn(ROW, branch.current ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      <Icon name="ok" className={cn('size-3 shrink-0', !branch.current && 'invisible')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <AheadBehind ahead={branch.ahead} behind={branch.behind} />
      {branch.lastCommit && (
        <span className="shrink-0 text-[10px] text-muted-foreground/80">{branch.lastCommit.relative}</span>
      )}
    </div>
  )
}

function WorktreeRow({
  worktree,
  onOpenWorktree
}: {
  worktree: GitWorktree
  onOpenWorktree(path: string): void
}): React.JSX.Element {
  const { name } = splitPath(worktree.path)
  const openable = !worktree.current && !worktree.prunable && !worktree.bare
  const ref = worktree.bare ? 'bare' : (worktree.branch ?? `${worktree.head.slice(0, 7)} (destacado)`)
  const notes = [
    worktree.current && 'worktree atual',
    worktree.locked && 'travada',
    worktree.prunable && 'podável: a pasta não existe mais',
    openable && 'clique para abrir como projeto'
  ].filter(Boolean)

  return (
    <div
      data-tip={[worktree.path, ...notes].join('\n')}
      onClick={() => {
        if (openable) onOpenWorktree(worktree.path)
      }}
      className={cn(ROW, 'pl-2', worktree.current ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
    >
      <Icon name="worktree" className="size-3.5 shrink-0" />
      <span className={cn('min-w-0 truncate', worktree.prunable && 'line-through opacity-70')}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{ref}</span>
      {worktree.locked && <Icon name="cadeado" className="size-3 shrink-0" />}
      {worktree.prunable && <Icon name="alerta" className="size-3 shrink-0 text-[#895503] dark:text-[#e2c08d]" />}
      {worktree.current && <Icon name="ok" className="size-3 shrink-0" />}
    </div>
  )
}

// Campo de nome de branch: criar (com "trocar para a nova") e renomear usam o mesmo.
function BranchNameInput({
  initial = '',
  disabled,
  submitLabel,
  withCheckout,
  onSubmit,
  onCancel
}: {
  initial?: string
  disabled: boolean
  submitLabel: string
  withCheckout: boolean
  onSubmit(name: string, checkout: boolean): void
  onCancel(): void
}): React.JSX.Element {
  const [name, setName] = useState(initial)
  const [checkout, setCheckout] = useState(true)

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed, checkout)
  }

  return (
    <div className="flex flex-col gap-1 py-1 pl-5 pr-2">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="nome-da-branch"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-sm bg-card px-1.5 text-xs text-foreground outline-none ring-1 ring-ring select-text"
        />
        <button
          type="button"
          data-tip={submitLabel}
          data-tip-shortcut="Enter"
          aria-label={submitLabel}
          disabled={disabled || !name.trim()}
          onClick={submit}
          className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Icon name="ok" className="size-3.5" />
        </button>
        <button
          type="button"
          data-tip="Cancelar"
          data-tip-shortcut="Esc"
          aria-label="Cancelar"
          onClick={onCancel}
          className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Icon name="fechar" className="size-3.5" />
        </button>
      </div>
      {withCheckout && (
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} className="size-3" />
          Trocar para a branch nova
        </label>
      )}
    </div>
  )
}

const menuIcon = (name: IconName): React.ReactNode => <Icon name={name} className="size-3.5" />

export function GitPanel({
  projectId,
  projectPath,
  status,
  branches,
  worktrees,
  loading,
  busy,
  error,
  onRefresh,
  onCreateBranch,
  onCheckout,
  onOpenFile,
  onOpenDiff,
  onOpenWorktree,
  remote,
  onInit,
  onSetRemote,
  onStage,
  onUnstage,
  onDiscard,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onPush,
  onPull,
  onSync,
  onFetch,
  run,
  operationBanner,
  stashSection
}: Props): React.JSX.Element {
  const confirm = useConfirm()
  const [branchesOpen, setBranchesOpen] = useState(true)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [amend, setAmend] = useState<Amend | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [historyFile, setHistoryFile] = useState<string | null>(null)
  // Erro de leitura que não passou pelo `run` (ex.: consultar o último commit antes de corrigir).
  const [localError, setLocalError] = useState<string | null>(null)
  // Qualquer ação que começa (stage, commit, push, pelos botões de fora do painel também) vale como resposta ao erro.
  useEffect(() => {
    if (busy !== null) setLocalError(null)
  }, [busy])
  // Guarda só as seções que o usuário inverteu em relação ao padrão (remotas começam fechadas, o resto aberto).
  const [toggled, setToggled] = useState<Set<string>>(new Set())

  const isOpen = (id: string, byDefault: boolean): boolean => byDefault !== toggled.has(id)
  const toggle = (id: string): void => {
    const next = new Set(toggled)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setToggled(next)
  }

  const isRepo = status?.isRepo === true
  const headLabel = status?.detached
    ? `HEAD destacado${status.oid ? ` em ${status.oid.slice(0, 7)}` : ''}`
    : (status?.branch ?? '—')

  const locals = branches.filter((b) => b.remote === null)
  const byRemote = new Map<string, GitBranch[]>()
  for (const b of branches) {
    if (b.remote !== null) byRemote.set(b.remote, [...(byRemote.get(b.remote) ?? []), b])
  }
  const remoteCount = branches.length - locals.length
  const working = busy !== null
  const files = isRepo ? status.files : []

  const act = (action: () => Promise<unknown>, label: string): Promise<boolean> => {
    setLocalError(null)
    return run(action, label)
  }

  const openEntry = (file: GitFile, preview: boolean): void => {
    if (opensAsFile(file)) onOpenFile(file.path, { preview })
    else onOpenDiff(file.path, file.staged, { ...(file.origPath ? { origPath: file.origPath } : {}), preview })
  }

  const openMenu = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // Rastreado volta à versão da fila (sem volta pelo git); não rastreado vai para a Lixeira (volta por lá).
  const discard = async (targets: GitFile[]): Promise<void> => {
    const untracked = targets.filter((f) => f.status === 'untracked').length
    const tracked = targets.length - untracked
    const single = targets.length === 1 ? splitPath(targets[0]!.path).name : null
    const title = single
      ? untracked
        ? `Mover "${single}" para a Lixeira?`
        : `Descartar as alterações em "${single}"?`
      : `Descartar ${targets.length} alterações?`
    const parts = [
      tracked > 0 &&
        (single ? 'O arquivo volta à versão da fila (ou do último commit). Não dá para desfazer.' : `${tracked} arquivo(s) voltam à versão da fila (ou do último commit). Não dá para desfazer.`),
      untracked > 0 &&
        (single ? 'O arquivo não é rastreado pelo git e vai para a Lixeira.' : `${untracked} arquivo(s) não rastreados vão para a Lixeira.`)
    ].filter(Boolean)
    const ok = await confirm({ title, message: parts.join(' '), confirmLabel: 'Descartar', danger: true })
    if (ok) onDiscard(targets.map((f) => f.path))
  }

  const commit = async (): Promise<void> => {
    const message = commitMessage
    if (amend) {
      if (amend.pushed) {
        const ok = await confirm({
          title: 'Corrigir um commit que já foi enviado?',
          message: `O commit ${amend.hash.slice(0, 7)} já está no remoto. Corrigir troca ele por outro, e o próximo Push vai precisar de force push, que reescreve o histórico do remoto.`,
          confirmLabel: 'Corrigir mesmo assim',
          danger: true
        })
        if (!ok) return
      }
      const draft = amend.draft
      if (await act(() => window.kora.gitAmend(projectId, message), 'Corrigindo o último commit…')) {
        setAmend(null)
        onCommitMessageChange(draft)
      }
      return
    }
    setLocalError(null)
    if ((await onCommit(message, false)) !== 'nothing-staged') return
    const ok = await confirm({
      title: 'Nada na fila',
      message: 'Colocar todas as alterações do projeto na fila e commitar?',
      confirmLabel: 'Colocar tudo e commitar'
    })
    if (ok) await onCommit(message, true)
  }

  const headCommit = async (): Promise<GitHeadCommit | undefined> => {
    setLocalError(null)
    try {
      const head = await window.kora.gitHeadCommit(projectId)
      if (!head) setLocalError('Ainda não há commits neste repositório.')
      return head ?? undefined
    } catch (err) {
      setLocalError(ipcErrorMessage(err))
      return undefined
    }
  }

  const startAmend = async (): Promise<void> => {
    const head = await headCommit()
    if (!head) return
    setAmend({ draft: commitMessage, hash: head.hash, pushed: head.pushed })
    onCommitMessageChange(head.message)
  }

  const cancelAmend = (): void => {
    if (amend) onCommitMessageChange(amend.draft)
    setAmend(null)
  }

  const undoLastCommit = async (): Promise<void> => {
    const head = await headCommit()
    if (!head) return
    if (head.isRoot) {
      setLocalError('Este é o primeiro commit do repositório: não há commit anterior para onde voltar.')
      return
    }
    const subject = head.message.split('\n')[0]
    const ok = await confirm({
      title: 'Desfazer o último commit?',
      message: [
        `"${subject}" sai do histórico e as alterações dele voltam para a fila. Os arquivos no disco não mudam.`,
        head.pushed && 'Esse commit já foi enviado: o remoto continua com ele, e o próximo Push vai precisar de force push.'
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Desfazer commit',
      danger: head.pushed
    })
    if (!ok) return
    const draft = commitMessage
    let undone: { message: string } | null = null
    await act(async () => {
      undone = await window.kora.gitUndoLastCommit(projectId)
    }, 'Desfazendo o último commit…')
    // Como no VS Code: a mensagem volta para a caixa, se ela estava vazia.
    const message = (undone as { message: string } | null)?.message
    if (message && !draft.trim()) onCommitMessageChange(message)
  }

  const commitMenu = (e: React.MouseEvent): void =>
    openMenu(e, [
      { label: 'Commitar (corrigir último)', icon: menuIcon('editar'), onSelect: () => void startAmend() },
      { label: 'Desfazer último commit', icon: menuIcon('descartar'), onSelect: () => void undoLastCommit() }
    ])

  const deleteBranch = async (name: string): Promise<void> => {
    let result: GitBranchDeleteResult | null = null
    const done = await act(async () => {
      result = await window.kora.gitDeleteBranch(projectId, name, false)
    }, 'Apagando a branch…')
    if (!done || (result as GitBranchDeleteResult | null) !== 'not-merged') return
    const ok = await confirm({
      title: `A branch "${name}" não foi mesclada`,
      message:
        'Ela tem commits que não estão na branch atual nem no upstream dela. Apagando, esses commits ficam sem nenhuma branch e podem se perder. Apagar mesmo assim?',
      confirmLabel: 'Apagar mesmo assim',
      danger: true
    })
    if (ok) await act(() => window.kora.gitDeleteBranch(projectId, name, true), 'Apagando a branch…')
  }

  const branchMenu = (e: React.MouseEvent, branch: GitBranch): void => {
    const items: MenuItem[] = []
    if (!branch.current) {
      items.push({ label: branch.remote ? 'Trocar (criar a branch local)' : 'Trocar para esta branch', icon: menuIcon('ok'), onSelect: () => onCheckout(branch.name, branch.remote) })
    }
    if (branch.remote === null) {
      items.push({ label: 'Renomear branch…', icon: menuIcon('editar'), onSelect: () => setRenaming(branch.name) })
      if (!branch.upstream && remote !== null) {
        items.push({ label: 'Publicar branch', icon: menuIcon('publicar'), onSelect: () => void act(() => window.kora.gitPublishBranch(projectId, branch.name), 'Publicando a branch…') })
      }
    }
    items.push({ label: 'Copiar nome da branch', icon: menuIcon('copiar'), onSelect: () => void navigator.clipboard.writeText(branch.name) })
    if (branch.remote === null && !branch.current) {
      items.push('separator', { label: 'Apagar branch', danger: true, icon: menuIcon('excluir'), onSelect: () => void deleteBranch(branch.name) })
    }
    openMenu(e, items)
  }

  const showHistory = (path: string): void => {
    setHistoryFile(path)
    if (!isOpen('history', true)) toggle('history')
    requestAnimationFrame(() => document.querySelector('[data-git-history]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  const fileMenu = (e: React.MouseEvent, file: GitFile): void => {
    const items: MenuItem[] = []
    if (!opensAsFile(file)) items.push({ label: 'Abrir alterações', icon: menuIcon('git'), onSelect: () => openEntry(file, false) })
    if (file.status !== 'deleted') items.push({ label: 'Abrir arquivo', icon: menuIcon('arquivo'), onSelect: () => onOpenFile(file.path) })
    if (existsInHead(file)) {
      items.push({ label: 'Abrir arquivo (HEAD)', onSelect: () => onOpenDiff(file.origPath ?? file.path, false, { commit: 'HEAD', fileAt: true }) })
    }
    items.push('separator')
    if (file.staged) items.push({ label: 'Tirar da fila', icon: menuIcon('menos'), onSelect: () => onUnstage(pathsOf([file])) })
    else items.push({ label: file.status === 'conflicted' ? 'Marcar como resolvido' : 'Colocar na fila', icon: menuIcon('novaAba'), onSelect: () => onStage([file.path]) })
    if (!file.staged && file.status !== 'conflicted') {
      items.push({ label: 'Descartar alterações', danger: true, icon: menuIcon('descartar'), onSelect: () => void discard([file]) })
    }
    if (file.status === 'untracked') {
      items.push({ label: 'Adicionar ao .gitignore', onSelect: () => void act(() => window.kora.gitAddToIgnore(projectId, [file.path]), 'Adicionando ao .gitignore…') })
    }
    items.push('separator')
    if (file.status !== 'deleted') {
      items.push({ label: 'Mostrar no Explorer', icon: menuIcon('pastaAberta'), onSelect: () => void window.kora.revealInExplorer(projectId, file.path) })
    }
    items.push(
      { label: 'Copiar caminho', icon: menuIcon('copiar'), onSelect: () => void copyPath(`${projectPath}\\${file.path}`) },
      { label: 'Copiar caminho relativo', onSelect: () => void copyPath(file.path) }
    )
    if (file.status !== 'untracked') items.push('separator', { label: 'Histórico do arquivo', onSelect: () => showHistory(file.origPath && file.status === 'deleted' ? file.origPath : file.path) })
    openMenu(e, items)
  }

  const fileActions = (file: GitFile): RowAction[] => {
    const open: RowAction[] =
      file.status === 'deleted' || opensAsFile(file) ? [] : [{ label: 'Abrir arquivo', icon: 'arquivo', run: () => onOpenFile(file.path) }]
    if (file.staged) return [...open, { label: 'Tirar da fila', icon: 'menos', run: () => onUnstage(pathsOf([file])) }]
    const discardAction: RowAction[] =
      file.status === 'conflicted' ? [] : [{ label: 'Descartar alterações', icon: 'descartar', danger: true, run: () => void discard([file]) }]
    const stage: RowAction =
      file.status === 'conflicted'
        ? { label: 'Marcar como resolvido', icon: 'ok', run: () => onStage([file.path]) }
        : { label: 'Colocar na fila', icon: 'novaAba', run: () => onStage([file.path]) }
    return [...open, ...discardAction, stage]
  }

  const groupActions = (id: string, list: GitFile[]): RowAction[] => {
    if (id === 'files:staged') return [{ label: 'Tirar tudo da fila', icon: 'menos', run: () => onUnstage(pathsOf(list)) }]
    if (id === 'files:conflicts') return []
    return [
      { label: 'Descartar todas', icon: 'descartar', danger: true, run: () => void discard(list) },
      { label: 'Colocar tudo na fila', icon: 'novaAba', run: () => onStage(list.map((f) => f.path)) }
    ]
  }

  const canSync = isRepo && !status.detached && status.branch !== null && (status.upstream !== null || remote !== null)
  // HEAD, branch e distância do upstream: qualquer mudança aí muda o que o histórico mostra (commit, push, troca).
  const historyKey = isRepo ? `${status.oid}|${status.branch}|${status.upstream}|${status.ahead}|${status.behind}` : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b pl-2 pr-2">
        <button
          type="button"
          disabled={!isRepo}
          data-tip={isRepo ? 'Branches e worktrees' : undefined}
          onClick={() => setBranchesOpen((open) => !open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-secondary/60 disabled:hover:bg-transparent"
        >
          <Icon name="git" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn('truncate font-medium', status?.detached && 'italic')}>{isRepo ? headLabel : 'Git'}</span>
          {isRepo && status.upstream && (
            <span data-tip={`${status.ahead} à frente e ${status.behind} atrás de ${status.upstream}`}>
              <AheadBehind ahead={status.ahead} behind={status.behind} />
            </span>
          )}
          {isRepo && (
            <Icon name="expandir"
              className={cn('ml-auto size-3 shrink-0 text-muted-foreground transition-transform', branchesOpen && 'rotate-90')}
            />
          )}
        </button>
        <button
          type="button"
          data-tip="Atualizar"
          aria-label="Atualizar"
          disabled={loading}
          onClick={onRefresh}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:hover:bg-transparent"
        >
          <Icon name="atualizar" className={cn('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {operationBanner}
      {isRepo && <RemoteRow remote={remote} onSave={onSetRemote} />}
      {isRepo && (
        <CommitBox
          message={commitMessage}
          disabled={working}
          canCommit={files.some((f) => f.status !== 'conflicted')}
          amend={amend}
          onChange={onCommitMessageChange}
          onCommit={() => void commit()}
          onMore={commitMenu}
          onCancelAmend={cancelAmend}
        />
      )}
      {canSync && (
        <SyncRow status={status} disabled={working} onPush={onPush} onPull={onPull} onSync={onSync} onFetch={onFetch} />
      )}
      {busy && (
        <p role="status" className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
          <Icon name="atualizar" className="size-3 animate-spin" />
          {busy}
        </p>
      )}
      {localError ? (
        <GitErrorNotice error={localError} onDismiss={() => setLocalError(null)} />
      ) : (
        error && <GitErrorNotice error={error} />
      )}

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
        {!status && loading && <p className="px-2 py-1 text-xs text-muted-foreground">Carregando…</p>}

        {status && !status.isRepo && (
          <div className="flex flex-col items-start gap-2 px-2 py-2">
            <p className="text-xs text-muted-foreground">Esta pasta ainda não é um repositório Git.</p>
            <Button disabled={loading} onClick={onInit}>
              Inicializar repositório
            </Button>
            <p className="text-[11px] text-muted-foreground">Cria o repositório local. Depois dá para vincular a uma URL do GitHub.</p>
          </div>
        )}

        {isRepo && branchesOpen && (
          <div className="mb-1 border-b pb-1">
            <SectionHeader
              title="Local"
              count={locals.length}
              open={isOpen('branches:local', true)}
              onToggle={() => toggle('branches:local')}
            />
            {isOpen('branches:local', true) && (
              <>
                {locals.map((b) =>
                  renaming === b.name ? (
                    <BranchNameInput
                      key={b.name}
                      initial={b.name}
                      disabled={working}
                      submitLabel="Renomear branch"
                      withCheckout={false}
                      onSubmit={(name) => {
                        setRenaming(null)
                        if (name !== b.name) void act(() => window.kora.gitRenameBranch(projectId, b.name, name), 'Renomeando a branch…')
                      }}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <BranchRow key={b.name} branch={b} label={b.name} depth={0} disabled={loading} onCheckout={onCheckout} onMenu={branchMenu} />
                  )
                )}
                {creating ? (
                  <BranchNameInput
                    disabled={loading}
                    submitLabel="Criar branch"
                    withCheckout
                    onSubmit={(name, checkout) => {
                      onCreateBranch(name, checkout)
                      setCreating(false)
                    }}
                    onCancel={() => setCreating(false)}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => setCreating(true)}
                    className={cn(ROW, 'w-full pl-2 text-muted-foreground hover:text-foreground disabled:opacity-40')}
                  >
                    <Icon name="novaAba" className="size-3 shrink-0" />
                    Nova branch
                  </button>
                )}
              </>
            )}

            {remoteCount > 0 && (
              <SectionHeader
                title="Remotas"
                count={remoteCount}
                open={isOpen('branches:remotes', true)}
                onToggle={() => toggle('branches:remotes')}
              />
            )}
            {remoteCount > 0 &&
              isOpen('branches:remotes', true) &&
              [...byRemote].map(([remote, list]) => {
                const id = `remote:${remote}`
                const open = isOpen(id, false)
                return (
                  <div key={id}>
                    <SectionHeader title={remote} count={list.length} depth={1} open={open} onToggle={() => toggle(id)} />
                    {open &&
                      list.map((b) => (
                        <BranchRow
                          key={b.name}
                          branch={b}
                          label={b.name.slice(remote.length + 1)}
                          depth={1}
                          disabled={loading}
                          onCheckout={onCheckout}
                          onMenu={branchMenu}
                        />
                      ))}
                  </div>
                )
              })}

            {worktrees.length > 0 && (
              <SectionHeader
                title="Worktrees"
                count={worktrees.length}
                open={isOpen('worktrees', true)}
                onToggle={() => toggle('worktrees')}
              />
            )}
            {worktrees.length > 0 &&
              isOpen('worktrees', true) &&
              worktrees.map((w) => <WorktreeRow key={w.path} worktree={w} onOpenWorktree={onOpenWorktree} />)}
          </div>
        )}

        {isRepo && status.files.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">Nenhuma alteração.</p>
        )}

        {isRepo &&
          FILE_GROUPS.map((group) => {
            const list = files.filter(group.match)
            if (list.length === 0) return null
            const open = isOpen(group.id, true)
            return (
              <div key={group.id} data-git-group={group.id}>
                <SectionHeader
                  title={group.title}
                  count={list.length}
                  open={open}
                  actions={groupActions(group.id, list)}
                  disabled={working}
                  onToggle={() => toggle(group.id)}
                />
                {open && (
                  <VirtualRows
                    items={list}
                    rowHeight={ROW_HEIGHT}
                    render={(file) => (
                      <FileRow
                        key={`${group.id}:${file.path}`}
                        file={file}
                        actions={fileActions(file)}
                        disabled={working}
                        onOpen={openEntry}
                        onMenu={fileMenu}
                      />
                    )}
                  />
                )}
              </div>
            )
          })}

        {stashSection}

        {isRepo && (
          <div className="mt-1 border-t pt-1">
            <SectionHeader title="Histórico" open={isOpen('history', true)} onToggle={() => toggle('history')} />
            {isOpen('history', true) && (
              <HistorySection
                projectId={projectId}
                refreshKey={historyKey}
                file={historyFile}
                onClearFile={() => setHistoryFile(null)}
                onOpenDiff={onOpenDiff}
              />
            )}
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
