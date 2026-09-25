import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/brand/icons'
import { copyPath } from '@/lib/copied-path'
import { cn } from '@/lib/utils'

interface Props {
  projectId: string
  path: string
  onReload(): void
  onOpenPath(rel: string, line: number | null): void
  onOpenExternal?(): void
  children?: ReactNode
}

export const headerButton = 'rounded-md p-1 hover:bg-secondary hover:text-foreground'

export function ViewerHeader({ projectId, path, onReload, onOpenPath, onOpenExternal, children }: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
      {editing ? (
        <PathEditor projectId={projectId} path={path} onOpen={onOpenPath} onDone={() => setEditing(false)} />
      ) : (
        <>
          <CopyablePath path={path} />
          <button
            type="button"
            title="Editar caminho para abrir outro arquivo"
            onClick={() => setEditing(true)}
            className={cn(headerButton, 'shrink-0')}
          >
            <Icon name="editar" className="size-3.5" />
          </button>
          <span className="flex-1" />
        </>
      )}
      {children}
      <button type="button" title="Recarregar arquivo" onClick={onReload} className={headerButton}>
        <Icon name="atualizar" className="size-3.5" />
      </button>
      {onOpenExternal && (
        <button type="button" title="Abrir no programa padrão" onClick={onOpenExternal} className={headerButton}>
          <Icon name="externo" className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function CopyablePath({ path }: { path: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = (): void => {
    void copyPath(path).then(() => {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      type="button"
      title={`${path}\nClique para copiar o caminho`}
      onClick={copy}
      className="group/path -mx-1.5 flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
    >
      <span data-path className="truncate">
        {path}
      </span>
      <Icon
        name={copied ? 'ok' : 'copiar'}
        className={cn('size-3 shrink-0', copied ? 'text-[var(--brand-amber)]' : 'invisible group-hover/path:visible')}
      />
      <span role="status" className="shrink-0 text-[var(--brand-amber)]">
        {copied ? 'Copiado' : ''}
      </span>
    </button>
  )
}

// Aceita caminho relativo ao projeto ou absoluto dentro dele, com :linha opcional, igual ao Ctrl+clique do terminal.
function PathEditor(props: {
  projectId: string
  path: string
  onOpen(rel: string, line: number | null): void
  onDone(): void
}): React.JSX.Element {
  const { projectId, path, onOpen, onDone } = props
  const [value, setValue] = useState(path)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const submit = async (): Promise<void> => {
    const text = value.trim()
    if (!text || text === path) return onDone()
    setChecking(true)
    const target = await window.kora.resolveTerminalLink(projectId, text).catch(() => null)
    setChecking(false)
    if (!target) {
      setError('Arquivo não encontrado neste projeto')
      return
    }
    onDone()
    onOpen(target.rel, target.line)
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        autoFocus
        aria-label="Caminho do arquivo"
        spellCheck={false}
        value={value}
        readOnly={checking}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          else if (e.key === 'Escape') onDone()
        }}
        onBlur={() => !checking && onDone()}
        className={cn(
          'h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-xs text-foreground outline-none focus:border-[var(--brand-amber)]',
          error && 'border-destructive focus:border-destructive'
        )}
      />
      {error && (
        <span role="alert" className="shrink-0 text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}
