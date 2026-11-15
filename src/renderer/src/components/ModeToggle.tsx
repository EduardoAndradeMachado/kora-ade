import { Icon } from '@/brand/icons'
import { cn } from '@/lib/utils'

export type MarkdownMode = 'preview' | 'split' | 'edit'

interface Props {
  mode: MarkdownMode
  // Só os ícones: no lado a lado o cabeçalho tem metade da largura.
  compact?: boolean
  // O SVG só alterna entre a imagem e o código, sem o lado a lado.
  modes?: readonly MarkdownMode[]
  onChange(mode: MarkdownMode): void
}

function SplitIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5 shrink-0"
    >
      <path d="M12 4.5h6a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-6z" fill={active ? 'var(--icon-accent)' : 'var(--icon-accent-idle)'} fillOpacity=".35" stroke="none" />
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M12 4.5v15" />
    </svg>
  )
}

const OPTIONS: { mode: MarkdownMode; label: string }[] = [
  { mode: 'preview', label: 'Visualizar' },
  { mode: 'split', label: 'Lado a lado' },
  { mode: 'edit', label: 'Editar' }
]

export function ModeToggle({ mode, compact = false, modes, onChange }: Props): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center rounded-md border bg-card p-0.5">
      {OPTIONS.filter((option) => !modes || modes.includes(option.mode)).map((option) => {
        const active = option.mode === mode
        return (
          <button
            key={option.mode}
            type="button"
            aria-pressed={active}
            aria-label={option.label}
            data-tip={option.label}
            onClick={() => !active && onChange(option.mode)}
            className={cn(
              'flex items-center gap-1.5 rounded-[5px] py-1 text-xs font-medium transition-colors',
              // Fora do lado a lado, o rótulo some quando o cabeçalho (o @container do ViewerHeader) aperta.
              compact ? 'px-1.5' : 'px-1.5 @2xl:px-2.5',
              active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.mode === 'split' ? (
              <SplitIcon active={active} />
            ) : (
              <Icon name={option.mode === 'preview' ? 'visualizar' : 'editar'} active={active} className="size-3.5" />
            )}
            {!compact && <span className="hidden @2xl:inline">{option.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
