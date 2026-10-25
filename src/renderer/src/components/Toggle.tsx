import { cn } from '@/lib/utils'

export function Toggle(props: { checked: boolean; label: string; detail: string; onChange(checked: boolean): void; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        onClick={() => props.onChange(!props.checked)}
        className={cn(
          'relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors',
          props.checked ? 'bg-[var(--brand-amber)]' : 'bg-secondary ring-1 ring-inset ring-border'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left]',
            props.checked ? 'left-[14px]' : 'left-0.5'
          )}
        />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-foreground">{props.label}</span>
        <span className="text-[11px] leading-snug text-muted-foreground">{props.detail}</span>
        {props.children}
      </div>
    </div>
  )
}
