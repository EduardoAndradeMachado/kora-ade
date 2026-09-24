import { useState } from 'react'
import { koraFileUrl } from '@shared/file-url'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ViewerHeader } from '@/components/ViewerHeader'

interface Props {
  projectId: string
  path: string
  visible: boolean
}

type Zoom = 'fit' | 'actual'

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(var(--checker-a) 0% 25%, var(--checker-b) 0% 50%)',
  backgroundSize: '16px 16px'
}

const zoomButton = (active: boolean): string =>
  cn('rounded-md px-1.5 py-0.5 hover:bg-secondary hover:text-foreground', active && 'bg-secondary text-foreground')

export function ImageView({ projectId, path, visible }: Props): React.JSX.Element {
  const [version, setVersion] = useState(0)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = (): void => {
    setFailed(false)
    setSize(null)
    setVersion((v) => v + 1)
  }

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  const fit = zoom === 'fit'

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader path={path} onReload={reload} onOpenExternal={openExternal}>
        {size && (
          <span className="shrink-0 tabular-nums">
            {size.width} × {size.height}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={() => setZoom('fit')} className={zoomButton(fit)}>
            Ajustar
          </button>
          <button type="button" onClick={() => setZoom('actual')} className={zoomButton(!fit)}>
            100%
          </button>
        </div>
      </ViewerHeader>
      {notice && <p className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{notice}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {failed ? (
          <p className="p-4 text-xs text-destructive">Não foi possível carregar a imagem.</p>
        ) : (
          // Margem automática num flex centraliza a imagem menor que a área sem cortar a borda
          // esquerda/superior da maior quando ela passa a rolar em 100%.
          <div className={cn('flex p-4', fit ? 'h-full w-full' : 'min-h-full w-max min-w-full')}>
            <img
              key={version}
              src={`${koraFileUrl(projectId, path)}?v=${version}`}
              alt={path}
              draggable={false}
              style={CHECKERBOARD}
              onClick={() => setZoom(fit ? 'actual' : 'fit')}
              onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              className={cn(
                'm-auto',
                fit ? 'max-h-full max-w-full cursor-zoom-in object-contain' : 'max-w-none cursor-zoom-out'
              )}
            />
          </div>
        )}
      </div>
    </div>
  )
}
