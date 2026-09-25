import { Icon } from '@/brand/icons'
import { cn } from '@/lib/utils'

interface Props {
  editing: boolean
  previewDisabledReason?: string
  onChange(editing: boolean): void
}

export function ModeToggle({ editing, previewDisabledReason, onChange }: Props): React.JSX.Element {
  const option = (active: boolean, disabled: boolean): string =>
    cn(
      'flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors',
      active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
    )
  return (
    <div className="flex shrink-0 items-center rounded-md border bg-card p-0.5">
      <button
        type="button"
        disabled={!!previewDisabledReason && editing}
        title={editing ? previewDisabledReason : undefined}
        onClick={() => onChange(false)}
        className={option(!editing, !!previewDisabledReason && editing)}
      >
        <Icon name="visualizar" active={!editing} className="size-3.5" />
        Visualizar
      </button>
      <button type="button" onClick={() => onChange(true)} className={option(editing, false)}>
        <Icon name="editar" active={editing} className="size-3.5" />
        Editar
      </button>
    </div>
  )
}
