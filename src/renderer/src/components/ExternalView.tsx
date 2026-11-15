import { useCallback, useEffect, useState } from 'react'
import { touchesFile } from '@shared/file-change'
import { Icon } from '@/brand/icons'
import { Button } from '@/brand/Button'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ViewerHeader } from '@/components/ViewerHeader'

interface Props {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  onOpenPath(rel: string, line: number | null): void
  onOpenAsText(): void
}

type Info = { size: number; mtimeMs: number; app: string | null }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = n / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toLocaleString('pt-BR', { maximumFractionDigits: size < 10 ? 1 : 0 })} ${units[unit]}`
}

const formatDate = (ms: number): string =>
  new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function ExternalView({ projectId, projectPath, path, visible, onOpenPath, onOpenAsText }: Props): React.JSX.Element {
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  // Um .exe não tem programa associado: o Windows executa o próprio arquivo.
  const runsItself = ext === '.exe'

  const load = useCallback((): (() => void) => {
    let cancelled = false
    window.kora.fileInfo(projectId, path).then(
      (next) => !cancelled && (setInfo(next), setError(null)),
      (err: unknown) => !cancelled && setError(ipcErrorMessage(err, path))
    )
    return () => {
      cancelled = true
    }
  }, [projectId, path])

  useEffect(load, [load])

  useEffect(
    () => window.kora.onFilesChanged((changedProject, change) => changedProject === projectId && touchesFile(change, path) && load()),
    [projectId, path, load]
  )

  const act = (action: Promise<void>): void => {
    setNotice(null)
    action.catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }
  const openExternal = (): void => act(window.kora.openFile(projectId, path))

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={load} onOpenExternal={openExternal} />
      {notice && <p className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{notice}</p>}

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <Icon name="arquivo" className="size-8 text-muted-foreground" />
          <div className="flex min-w-0 max-w-full flex-col gap-1">
            <div className="break-all text-sm font-medium">{name}</div>
            <div className="text-xs text-muted-foreground">
              {[ext ? `Arquivo ${ext}` : 'Arquivo sem extensão', info && formatBytes(info.size), info && `modificado em ${formatDate(info.mtimeMs)}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>

          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {!info
                ? 'Carregando…'
                : runsItself
                  ? 'É um programa: abrir no programa padrão vai executá-lo.'
                  : info.app
                    ? <>Abre com: <span className="text-foreground">{info.app}</span></>
                    : `Nenhum programa do Windows está associado a ${ext || 'arquivos sem extensão'}. Ao abrir, o Windows pergunta qual usar.`}
            </p>
          )}

          <div className="mt-1 grid w-full max-w-xs grid-cols-2 gap-2">
            <Button onClick={openExternal} className="col-span-2 w-full">
              <Icon name="externo" className="size-3.5 shrink-0" />
              Abrir no programa padrão
            </Button>
            <Button variant="secondary" onClick={() => act(window.kora.revealInExplorer(projectId, path))} className="w-full px-2 font-medium">
              <Icon name="pastaAberta" className="size-3.5 shrink-0" />
              <span className="truncate">Mostrar no Explorer</span>
            </Button>
            <Button variant="secondary" onClick={onOpenAsText} className="w-full px-2 font-medium">
              <Icon name="codigo" className="size-3.5 shrink-0" />
              <span className="truncate">Abrir como texto</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
