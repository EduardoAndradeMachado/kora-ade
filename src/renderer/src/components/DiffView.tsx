import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { EDITOR_OPTIONS, monaco, themeForDocument } from '@/lib/monaco'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { touchesFile } from '@shared/file-change'
import { headerButton, ViewerHeader } from '@/components/ViewerHeader'

interface Props {
  projectId: string
  path: string
  staged: boolean
  visible: boolean
  fontSize: number
  wordWrap: boolean
  onOpenPath(rel: string, line: number | null): void
}

type Load = { status: 'loading' } | { status: 'ready'; same: boolean } | { status: 'binary' } | { status: 'error'; message: string }

let modelCounter = 0

// A extensão do caminho escolhe a linguagem; a query deixa as URIs únicas (o Monaco recusa duas iguais).
const modelUri = (side: string, projectId: string, path: string): monaco.Uri =>
  monaco.Uri.file(`/${projectId}/${path.replace(/\\/g, '/')}`).with({ query: `diff=${side}-${++modelCounter}` })

export function DiffView({ projectId, path, staged, visible, fontSize, wordWrap, onOpenPath }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null)
  const loadRef = useRef<() => void>(() => {})
  const [load, setLoad] = useState<Load>({ status: 'loading' })

  useEffect(() => {
    if (!hostRef.current) return
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      ...EDITOR_OPTIONS,
      fontSize,
      wordWrap: wordWrap ? 'on' : 'off',
      theme: themeForDocument(),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true
    })
    const original = monaco.editor.createModel('', undefined, modelUri('original', projectId, path))
    const modified = monaco.editor.createModel('', undefined, modelUri('modified', projectId, path))
    editor.setModel({ original, modified })
    editorRef.current = editor
    modelsRef.current = { original, modified }
    return () => {
      editorRef.current = null
      modelsRef.current = null
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
    // fontSize e wordWrap iniciais; as mudanças depois vão pelos efeitos abaixo sem recriar o editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path])

  useEffect(() => {
    let cancelled = false
    let pending = false
    let running = false
    // O watcher manda rajadas: uma leitura por vez, e mais uma no fim se algo mudou no meio.
    const fetchDiff = async (): Promise<void> => {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        const diff = await window.kora.gitDiff(projectId, path, staged)
        const models = modelsRef.current
        if (cancelled || !models) return
        if (diff.binary) return setLoad({ status: 'binary' })
        if (models.original.getValue() !== diff.original) models.original.setValue(diff.original)
        if (models.modified.getValue() !== diff.modified) models.modified.setValue(diff.modified)
        setLoad({ status: 'ready', same: diff.original === diff.modified })
      } catch (err) {
        if (!cancelled) setLoad({ status: 'error', message: ipcErrorMessage(err) })
      } finally {
        running = false
        if (pending && !cancelled) {
          pending = false
          void fetchDiff()
        }
      }
    }
    loadRef.current = () => void fetchDiff()
    void fetchDiff()
    const off = window.kora.onFilesChanged((changedProject, change) => {
      if (changedProject === projectId && (change.git || touchesFile(change, path))) void fetchDiff()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [projectId, path, staged])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize })
  }, [fontSize])

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
  }, [wordWrap])

  return (
    <div data-diff-view={staged ? 'staged' : 'working'} className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} path={path} onOpenPath={onOpenPath} onReload={() => loadRef.current()}>
        {load.status === 'ready' && load.same && <span className="shrink-0">Sem diferenças</span>}
        <span className="shrink-0" data-tip={staged ? 'Último commit (HEAD) à esquerda, versão na fila à direita' : 'Versão na fila à esquerda, arquivo no disco à direita'}>
          {staged ? 'HEAD ↔ na fila' : 'na fila ↔ disco'}
        </span>
        <button type="button" data-tip="Abrir o arquivo" aria-label="Abrir o arquivo" onClick={() => onOpenPath(path, null)} className={cn(headerButton, 'shrink-0')}>
          <Icon name="arquivo" className="size-3.5" />
        </button>
      </ViewerHeader>
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} data-file-text className={cn('absolute inset-0', load.status !== 'ready' && 'invisible')} />
        {load.status === 'loading' && <p className="absolute p-4 text-xs text-muted-foreground">Carregando…</p>}
        {load.status === 'binary' && <p className="absolute p-4 text-xs text-muted-foreground">Arquivo binário: sem diff de texto.</p>}
        {load.status === 'error' && <p className="absolute p-4 text-xs text-destructive">{load.message}</p>}
      </div>
    </div>
  )
}
