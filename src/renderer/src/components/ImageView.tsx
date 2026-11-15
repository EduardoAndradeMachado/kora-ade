import { useEffect, useState } from 'react'
import { koraFileUrl } from '@shared/file-url'
import { touchesFile } from '@shared/file-change'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { hasConflictBlocks } from '@/lib/git-conflicts'
import { useSaveShortcut } from '@/lib/use-save-shortcut'
import { cn } from '@/lib/utils'
import { ViewerHeader } from '@/components/ViewerHeader'
import { ModeToggle, type MarkdownMode } from '@/components/ModeToggle'

interface Props {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  onOpenPath(rel: string, line: number | null): void
  onOpenAsText?(): void
  // O editor do SVG tem alteração que ainda não foi para o disco: a imagem mostra o arquivo salvo.
  unsaved?: boolean
}

type Zoom = 'fit' | 'actual'

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(var(--checker-a) 0% 25%, var(--checker-b) 0% 50%)',
  backgroundSize: '16px 16px'
}

export const SVG_MODES: readonly MarkdownMode[] = ['preview', 'edit']
export const isSvg = (path: string): boolean => /\.svg$/i.test(path)

const zoomButton = (active: boolean): string =>
  cn('rounded-md px-1.5 py-0.5 hover:bg-secondary hover:text-foreground', active && 'bg-secondary text-foreground')

export function ImageView({ projectId, projectPath, path, visible, onOpenPath, onOpenAsText, unsaved = false }: Props): React.JSX.Element {
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

  // Só leitura: mudou no disco (o Ctrl+S do SVG, um agente gerando a imagem), mostra a nova.
  useEffect(
    () =>
      window.kora.onFilesChanged((changedProject, change) => {
        if (changedProject !== projectId || !touchesFile(change, path)) return
        setFailed(false)
        setVersion((v) => v + 1)
      }),
    [projectId, path]
  )

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  // SVG com marcadores de conflito não é XML válido e não carrega: vai para o editor, que mostra os blocos.
  const openIfConflicted = (): void => {
    if (!onOpenAsText || !isSvg(path)) return
    window.kora.readText(projectId, path).then(
      (file) => hasConflictBlocks(file.content) && onOpenAsText(),
      () => {}
    )
  }

  const fit = zoom === 'fit'

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={reload} onOpenExternal={openExternal}>
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
        {onOpenAsText && isSvg(path) && <ModeToggle mode="preview" modes={SVG_MODES} onChange={(mode) => mode === 'edit' && onOpenAsText()} />}
      </ViewerHeader>
      {unsaved && (
        <p className="border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          Mostrando a versão salva. Salve (Ctrl+S) para ver as alterações do editor aqui.
        </p>
      )}
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
              onError={() => {
                setFailed(true)
                openIfConflicted()
              }}
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

interface SvgTabProps extends Omit<Props, 'onOpenAsText' | 'unsaved'> {
  mode: 'preview' | 'edit'
  dirty: boolean
  // O CodeView da aba, ou null quando ele não precisa existir (imagem sem nada por salvar).
  editor: React.ReactNode
  onModeChange(mode: MarkdownMode): void
  onSave?(): void
}

// Como no Markdown: com alteração não salva o editor fica montado (escondido) atrás da imagem, para a alteração não
// se perder ao alternar. A imagem é a do disco, como no VS Code; o aviso diz isso.
export function SvgTab({ editor, mode, dirty, visible, onModeChange, onSave, ...image }: SvgTabProps): React.JSX.Element {
  useSaveShortcut(visible && mode === 'preview' && dirty, onSave)
  return (
    <div className={cn('absolute inset-0', !visible && 'invisible')}>
      <div className={cn('absolute inset-0', mode === 'preview' && 'invisible')}>{editor}</div>
      {mode === 'preview' && <ImageView {...image} visible={visible} unsaved={dirty} onOpenAsText={() => onModeChange('edit')} />}
    </div>
  )
}
