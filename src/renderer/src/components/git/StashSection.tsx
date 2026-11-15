import { useEffect, useState } from 'react'
import type { GitStash, GitStashFile, GitStatus } from '@shared/git-types'
import { Icon, type IconName } from '@/brand/icons'
import { Button } from '@/brand/Button'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/components/ConfirmDialog'
import type { GitState } from '@/lib/use-git'

const ROW = 'flex h-6 cursor-default items-center gap-1.5 rounded pr-2 text-xs hover:bg-secondary/60'
const ACTION =
  'rounded p-0.5 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent'

function ActionButton({ label, icon, danger, disabled, onClick }: { label: string; icon: IconName; danger?: boolean; disabled: boolean; onClick(): void }): React.JSX.Element {
  return (
    <button
      type="button"
      data-tip={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(ACTION, danger ? 'hover:text-destructive' : 'hover:text-foreground')}
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  )
}

function StashForm({ disabled, onSubmit, onCancel }: { disabled: boolean; onSubmit(message: string, untracked: boolean): void; onCancel(): void }): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [untracked, setUntracked] = useState(false)
  const submit = (): void => {
    if (!disabled) onSubmit(message, untracked)
  }
  return (
    <div className="flex flex-col gap-1 py-1 pl-5 pr-2">
      <input
        autoFocus
        aria-label="Mensagem do stash"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Mensagem (opcional)"
        spellCheck={false}
        className="h-6 min-w-0 rounded-sm bg-card px-1.5 text-xs text-foreground outline-none ring-1 ring-ring select-text"
      />
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} className="size-3" />
        Incluir não rastreados
      </label>
      <div className="flex justify-end gap-1.5">
        <Button variant="secondary" onClick={onCancel} className="px-2.5 py-1">
          Cancelar
        </Button>
        <Button disabled={disabled} onClick={submit} className="px-2.5 py-1">
          Guardar
        </Button>
      </div>
    </div>
  )
}

function StashRow({
  stash,
  disabled,
  onApply,
  onPop,
  onDrop,
  loadFiles
}: {
  stash: GitStash
  disabled: boolean
  onApply(): void
  onPop(): void
  onDrop(): void
  loadFiles(): Promise<GitStashFile[]>
}): React.JSX.Element {
  const [files, setFiles] = useState<GitStashFile[] | 'loading' | 'error' | null>(null)
  const open = files !== null
  const toggle = (): void => {
    if (open) return setFiles(null)
    setFiles('loading')
    loadFiles().then(setFiles, () => setFiles('error'))
  }
  const title = [stash.message || `stash@{${stash.index}}`, stash.branch ? `em ${stash.branch}` : 'HEAD destacado', stash.relative].join(' · ')
  return (
    <div>
      <div data-git-stash={stash.index} data-tip={`${title}\nclique para ver os arquivos`} onClick={toggle} className={cn(ROW, 'group pl-2')}>
        <Icon name="expandir" className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-foreground">{stash.message || `stash@{${stash.index}}`}</span>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
          <ActionButton label="Aplicar" icon="retomar" disabled={disabled} onClick={onApply} />
          <ActionButton label="Aplicar e remover (pop)" icon="colar" disabled={disabled} onClick={onPop} />
          <ActionButton label="Remover" icon="excluir" danger disabled={disabled} onClick={onDrop} />
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/80">{stash.relative}</span>
      </div>
      {open && (
        <div className="pb-1 pl-8 pr-2 text-[11px] text-muted-foreground">
          {files === 'loading' && <p>Carregando…</p>}
          {files === 'error' && <p className="text-destructive">Não foi possível listar os arquivos.</p>}
          {Array.isArray(files) &&
            (files.length === 0 ? (
              <p>Sem arquivos.</p>
            ) : (
              files.map((f) => (
                <p key={f.path} className="flex gap-1.5 truncate" data-tip={f.path}>
                  <span className="w-3 shrink-0 text-center font-mono">{f.status}</span>
                  <span className="truncate">{f.path}</span>
                </p>
              ))
            ))}
        </div>
      )}
    </div>
  )
}

// Seção recolhível do GitPanel, como "Stashes" do VS Code. A lista é relida quando o número de entradas muda
// (o status conta pelo reflog, sem outro processo) e depois de cada ação daqui.
export function StashSection({ projectId, status, git }: { projectId: string; status: GitStatus | null; git: GitState }): React.JSX.Element | null {
  const confirm = useConfirm()
  const [open, setOpen] = useState(true)
  const [creating, setCreating] = useState(false)
  const [stashes, setStashes] = useState<GitStash[]>([])
  const [reload, setReload] = useState(0)
  const count = status?.isRepo ? (status.stashCount ?? 0) : 0
  const hasChanges = status?.isRepo === true && status.files.length > 0
  const disabled = git.busy !== null

  useEffect(() => {
    if (count === 0) return setStashes([])
    let cancelled = false
    window.kora.gitStashList(projectId).then(
      (list) => !cancelled && setStashes(list),
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [projectId, count, reload])

  if (!status?.isRepo || (count === 0 && !hasChanges && !creating)) return null

  const act = async (action: () => Promise<unknown>, label: string): Promise<void> => {
    await git.run(action, label)
    setReload((n) => n + 1)
  }

  const drop = async (stash: GitStash): Promise<void> => {
    const ok = await confirm({
      title: `Remover o stash "${stash.message || `stash@{${stash.index}}`}"?`,
      message: 'As alterações guardadas nele se perdem. Não dá para desfazer pelo Kora.',
      confirmLabel: 'Remover',
      danger: true
    })
    if (ok) await act(() => window.kora.gitStashDrop(projectId, stash), 'Removendo o stash…')
  }

  return (
    <div data-git-group="stash" className="mt-1">
      <div onClick={() => setOpen((o) => !o)} className={cn(ROW, 'group gap-1 pl-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground')}>
        <Icon name="expandir" className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="flex-1 truncate">Stash</span>
        <span className="hidden shrink-0 items-center gap-0.5 normal-case group-hover:flex group-focus-within:flex">
          <ActionButton
            label="Guardar alterações (stash)…"
            icon="baixar"
            disabled={disabled || !hasChanges}
            onClick={() => {
              setOpen(true)
              setCreating(true)
            }}
          />
        </span>
        <span className="rounded-full bg-secondary px-1.5 text-[10px] leading-4 normal-case">{count}</span>
      </div>
      {open && creating && (
        <StashForm
          disabled={disabled}
          onCancel={() => setCreating(false)}
          onSubmit={(message, untracked) => {
            setCreating(false)
            void act(() => window.kora.gitStashPush(projectId, message, untracked), 'Guardando no stash…')
          }}
        />
      )}
      {open &&
        stashes.map((stash) => (
          <StashRow
            key={stash.oid}
            stash={stash}
            disabled={disabled}
            onApply={() => void act(() => window.kora.gitStashApply(projectId, stash, false), 'Aplicando o stash…')}
            onPop={() => void act(() => window.kora.gitStashApply(projectId, stash, true), 'Aplicando o stash…')}
            onDrop={() => void drop(stash)}
            loadFiles={() => window.kora.gitStashFiles(projectId, stash)}
          />
        ))}
      {open && count === 0 && !creating && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setCreating(true)}
          className={cn(ROW, 'w-full pl-5 text-muted-foreground hover:text-foreground disabled:opacity-40')}
        >
          <Icon name="baixar" className="size-3 shrink-0" />
          Guardar alterações (stash)…
        </button>
      )}
    </div>
  )
}
