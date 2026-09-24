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

// O visualizador de PDF é o do próprio Chromium, carregado pelo protocolo kora-file do main.
export function PdfView({ projectId, path, visible }: Props): React.JSX.Element {
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader path={path} onReload={() => setVersion((v) => v + 1)} onOpenExternal={openExternal} />
      {notice && <p className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{notice}</p>}
      <iframe
        title={path}
        // A query muda a cada recarga para o Chromium não reaproveitar o PDF antigo.
        src={`${koraFileUrl(projectId, path)}?v=${version}`}
        className="min-h-0 w-full flex-1 border-0 bg-canvas"
      />
    </div>
  )
}
