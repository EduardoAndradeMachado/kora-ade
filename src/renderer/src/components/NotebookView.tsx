import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { touchesFile } from '@shared/file-change'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ViewerHeader, headerButton } from '@/components/ViewerHeader'
import { loadNotebook, type Notebook } from '@/lib/notebook'

interface Props {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  onOpenPath(rel: string, line: number | null): void
  onOpenAsText(): void
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; notebook: Notebook }

// force: notebook com gráficos embutidos passa fácil dos 5 MB do editor de texto, e aqui ele só é desenhado.
function readNotebook(projectId: string, path: string): Promise<Load> {
  return window.kora.readText(projectId, path, { force: true }).then(
    (file) => loadNotebook(file.content),
    (err: unknown) => ({ status: 'error', message: ipcErrorMessage(err, path) })
  )
}

// Monaco só carrega quando há código para colorir; o resto do notebook aparece antes.
// Indexado pelo código, não pela posição: ao reler com células novas, o realce antigo nunca cai na célula errada.
async function colorize(notebook: Notebook): Promise<Map<string, string>> {
  const { monaco, themeForDocument } = await import('@/lib/monaco')
  monaco.editor.setTheme(themeForDocument())
  const known = monaco.languages.getLanguages().find((l) => l.id === notebook.language || l.aliases?.some((a) => a.toLowerCase() === notebook.language))
  const language = known?.id ?? 'plaintext'
  const html = new Map<string, string>()
  await Promise.all(
    notebook.cells.map(async (cell) => {
      if (cell.type === 'code' && cell.source) html.set(cell.source, await monaco.editor.colorize(cell.source, language, { tabSize: 4 }))
    })
  )
  return html
}

const prompt = (count: number | null, label: 'In' | 'Out'): string => `${label} [${count ?? ' '}]`

export function NotebookView({ projectId, projectPath, path, visible, onOpenPath, onOpenAsText }: Props): React.JSX.Element {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [highlighted, setHighlighted] = useState<Map<string, string>>(new Map())
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void readNotebook(projectId, path).then((next) => !cancelled && setLoad(next))
    return () => {
      cancelled = true
    }
  }, [projectId, path, reloadKey])

  // Só leitura, sem nada a perder: mudou no disco (um agente rodou o notebook), relê.
  useEffect(
    () =>
      window.kora.onFilesChanged((changedProject, change) => {
        if (changedProject === projectId && touchesFile(change, path)) setReloadKey((k) => k + 1)
      }),
    [projectId, path]
  )

  const notebook = load.status === 'ready' ? load.notebook : null
  useEffect(() => {
    if (!notebook) return
    let cancelled = false
    colorize(notebook).then(
      (html) => !cancelled && setHighlighted(html),
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [notebook])

  const markdown = useMemo(
    () =>
      new Map(
        (notebook?.cells ?? []).flatMap((cell, i) =>
          cell.type === 'markdown' ? [[i, DOMPurify.sanitize(marked.parse(cell.source, { async: false, gfm: true }))] as const] : []
        )
      ),
    [notebook]
  )

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={() => setReloadKey((k) => k + 1)} onOpenExternal={openExternal}>
        <button type="button" onClick={onOpenAsText} className={cn(headerButton, 'shrink-0 px-1.5 py-0.5')}>
          Editar JSON
        </button>
      </ViewerHeader>
      {notice && <p className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{notice}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto select-text">
        {load.status === 'loading' && <p className="p-4 text-xs text-muted-foreground">Carregando…</p>}
        {load.status === 'error' && (
          <div className="flex flex-col items-start gap-3 p-4">
            <p className="text-xs text-destructive">{load.message}</p>
            <button
              type="button"
              onClick={onOpenAsText}
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Abrir como texto
            </button>
          </div>
        )}
        {notebook && (
          <div
            data-file-text
            className="mx-auto flex max-w-4xl flex-col gap-3 px-6 py-5 text-[13px]"
            onClick={(e) => {
              const link = (e.target as HTMLElement).closest('a')
              if (!link) return
              e.preventDefault()
              if (/^https?:\/\//.test(link.href)) window.open(link.href)
            }}
          >
            {notebook.cells.length === 0 && <p className="text-xs text-muted-foreground">Notebook sem células.</p>}
            {notebook.cells.map((cell, i) => {
              if (cell.type === 'markdown') {
                return <article key={i} className="markdown" dangerouslySetInnerHTML={{ __html: markdown.get(i) ?? '' }} />
              }
              if (cell.type === 'raw') {
                return (
                  <pre key={i} className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                    {cell.source}
                  </pre>
                )
              }
              const html = highlighted.get(cell.source)
              return (
                <section key={i} className="flex flex-col gap-1.5">
                  <div className="flex gap-3">
                    <span className="w-14 shrink-0 pt-2 text-right font-mono text-[11px] text-muted-foreground">{prompt(cell.count, 'In')}</span>
                    {html ? (
                      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-card p-2 font-mono text-xs" dangerouslySetInnerHTML={{ __html: html }} />
                    ) : (
                      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-card p-2 font-mono text-xs">{cell.source}</pre>
                    )}
                  </div>
                  {cell.outputs.map((output, j) => (
                    <div key={j} className="flex gap-3">
                      <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                        {output.count !== null ? prompt(output.count, 'Out') : ''}
                      </span>
                      {output.kind === 'image' ? (
                        <img src={output.src} alt={`Saída ${j + 1} da célula ${i + 1}`} className="max-w-full self-start bg-white" />
                      ) : (
                        <pre
                          className={cn(
                            'min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs',
                            output.stderr && 'rounded-md bg-destructive/10 px-2 py-1 text-destructive'
                          )}
                        >
                          {output.text}
                        </pre>
                      )}
                    </div>
                  ))}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
