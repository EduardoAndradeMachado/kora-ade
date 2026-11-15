import { useEffect, useRef, useState } from 'react'
import { koraFileUrl } from '@shared/file-url'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ViewerHeader } from '@/components/ViewerHeader'

interface Props {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  onOpenPath(rel: string, line: number | null): void
}

const AUDIO = /\.(mp3|wav|ogg|flac|m4a)$/i

export function MediaView({ projectId, projectPath, path, visible, onOpenPath }: Props): React.JSX.Element {
  const [version, setVersion] = useState(0)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const setMedia = (el: HTMLMediaElement | null): void => {
    mediaRef.current = el
  }

  // A aba escondida continua montada: sem pausar, o som seguiria tocando atrás de outra aba.
  useEffect(() => {
    if (!visible) mediaRef.current?.pause()
  }, [visible])

  const reload = (): void => {
    setFailed(false)
    setVersion((v) => v + 1)
  }

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  // A query muda a cada recarga para o Chromium não reaproveitar o arquivo antigo.
  const src = `${koraFileUrl(projectId, path)}?v=${version}`
  const onError = (): void => setFailed(true)

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={reload} onOpenExternal={openExternal} />
      {notice && <p className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{notice}</p>}

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {failed ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-xs text-destructive">Não foi possível tocar este arquivo aqui (formato ou codec sem suporte).</p>
            <button
              type="button"
              onClick={openExternal}
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Abrir no programa padrão
            </button>
          </div>
        ) : AUDIO.test(path) ? (
          <audio key={version} ref={setMedia} src={src} controls preload="metadata" onError={onError} className="w-full max-w-xl" />
        ) : (
          <video key={version} ref={setMedia} src={src} controls preload="metadata" onError={onError} className="max-h-full max-w-full bg-black" />
        )}
      </div>
    </div>
  )
}
