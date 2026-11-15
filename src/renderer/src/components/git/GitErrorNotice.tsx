import { useState } from 'react'
import { GIT_ERROR_DETAIL } from '@shared/git-types'
import { Icon } from '@/brand/icons'

export function splitGitError(error: string): { message: string; detail: string | null } {
  const at = error.indexOf(GIT_ERROR_DETAIL)
  if (at === -1) return { message: error, detail: null }
  return { message: error.slice(0, at), detail: error.slice(at + GIT_ERROR_DETAIL.length) || null }
}

// Explicação em português na frente; a saída do git, recolhida em "Detalhes". Fechar esconde só este erro: o
// próximo que chegar aparece. Com onDismiss, quem guarda o erro é que o apaga.
export function GitErrorNotice({ error, onDismiss }: { error: string; onDismiss?(): void }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  if (error === dismissed) return null
  const { message, detail } = splitGitError(error)
  return (
    <div role="alert" className="flex shrink-0 items-start gap-1.5 px-3 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <p className="break-words text-destructive select-text">{message}</p>
        {detail && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="mt-0.5 flex items-center gap-0.5 rounded text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="expandir" className={open ? 'size-3 rotate-90' : 'size-3'} />
            Detalhes
          </button>
        )}
        {detail && open && (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-card p-1.5 font-mono text-[11px] text-muted-foreground select-text">
            {detail}
          </pre>
        )}
      </div>
      <button
        type="button"
        aria-label="Fechar"
        data-tip="Fechar"
        onClick={() => (onDismiss ? onDismiss() : setDismissed(error))}
        className="rounded p-0.5 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="fechar" className="size-3" />
      </button>
    </div>
  )
}
