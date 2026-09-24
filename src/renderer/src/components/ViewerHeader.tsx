import type { ReactNode } from 'react'
import { Icon } from '@/brand/icons'

interface Props {
  path: string
  onReload(): void
  onOpenExternal?(): void
  children?: ReactNode
}

export const headerButton = 'rounded-md p-1 hover:bg-secondary hover:text-foreground'

export function ViewerHeader({ path, onReload, onOpenExternal, children }: Props): React.JSX.Element {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={path}>
        {path}
      </span>
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
