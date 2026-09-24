import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'danger'

// Botões da identidade: retângulo com canto de 8 px; principal preenchido em âmbar com texto tinta,
// secundário no cinza da superfície. Ícone dentro do secundário mantém o detalhe âmbar.
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-[var(--brand-amber)] text-[var(--brand-ink)] hover:brightness-105 [--icon-accent:currentColor]',
  secondary: 'bg-secondary text-foreground hover:bg-accent',
  danger: 'bg-destructive text-white hover:opacity-90 [--icon-accent:currentColor]'
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: React.ComponentProps<'button'> & { variant?: Variant }): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
        VARIANTS[variant],
        className
      )}
    />
  )
}
