import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { cn } from '@/lib/utils'
import { ViewerHeader } from '@/components/ViewerHeader'
import { ModeToggle } from '@/components/ModeToggle'

interface Props {
  projectId: string
  path: string
  visible: boolean
  fontSize: number
  onEdit(): void
  onOpenPath(rel: string, line: number | null): void
}

export function MarkdownView({ projectId, path, visible, fontSize, onEdit, onOpenPath }: Props): React.JSX.Element {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    window.kora.readText(projectId, path).then(
      (file) => !cancelled && (setSource(file.content), setError(null)),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      cancelled = true
    }
  }, [projectId, path, reloadKey])

  const html = useMemo(
    () => (source === null ? '' : DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }))),
    [source]
  )

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} path={path} onOpenPath={onOpenPath} onReload={() => setReloadKey((k) => k + 1)}>
        <ModeToggle editing={false} onChange={(editing) => editing && onEdit()} />
      </ViewerHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="p-4 text-xs text-destructive">{error}</p>
        ) : source === null ? (
          <p className="p-4 text-xs text-muted-foreground">Carregando…</p>
        ) : (
          <article
            data-file-text
            style={{ fontSize }}
            className="markdown mx-auto max-w-3xl px-6 py-5"
            onClick={(e) => {
              const link = (e.target as HTMLElement).closest('a')
              if (!link) return
              e.preventDefault()
              if (/^https?:\/\//.test(link.href)) window.open(link.href)
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  )
}
