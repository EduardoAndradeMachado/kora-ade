import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { parseQuery, rankFiles } from '@/lib/quick-open'
import { cn } from '@/lib/utils'

interface Props {
  projectId: string
  // Arquivos vistos por último neste projeto, o mais recente primeiro.
  recent: string[]
  // Recentes que não existem mais (apagados ou movidos por fora): saem da lista de quem guarda os recentes.
  onMissing(paths: string[]): void
  onOpen(rel: string, line: number | null): void
  onClose(): void
}

const keyOf = (path: string): string => path.replace(/\//g, '\\').toLowerCase()

const split = (path: string): { name: string; folder: string } => {
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return { name: path.slice(at + 1), folder: at > 0 ? path.slice(0, at) : '' }
}

export function QuickOpen({ projectId, recent, onMissing, onOpen, onClose }: Props): React.JSX.Element {
  const [files, setFiles] = useState<string[] | null>(null)
  // Recentes fora da listagem (ignorados pelo git, abertos pelo terminal) que o disco confirmou existir.
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const onMissingRef = useRef(onMissing)
  onMissingRef.current = onMissing
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Esc devolve o foco para onde ele estava (editor, árvore); escolher um arquivo deixa a aba nova cuidar dele.
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)

  useEffect(() => {
    let alive = true
    window.kora.listProjectFiles(projectId).then(
      (list) => alive && setFiles(list),
      () => {
        if (!alive) return
        setFiles([])
        setError('Não foi possível listar os arquivos do projeto')
      }
    )
    return () => {
      alive = false
    }
  }, [projectId])

  const listed = useMemo(() => (files ? new Set(files.map(keyOf)) : null), [files])
  // Recente que não está na listagem só aparece depois de o disco confirmar que existe: renomeado, movido ou
  // apagado por fora some da lista em vez de abrir uma aba com erro. Cada caminho é perguntado uma vez por paleta
  // aberta (a paleta remonta a cada Ctrl+P e a cada troca de projeto).
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (!listed) return
    const unknown = recent.filter((p) => !listed.has(keyOf(p)) && !asked.current.has(p))
    if (unknown.length === 0) return
    for (const p of unknown) asked.current.add(p)
    void Promise.all(unknown.map((p) => window.kora.fileExists(projectId, p).catch(() => false))).then((exists) => {
      const gone = unknown.filter((_, i) => !exists[i])
      const found = unknown.filter((_, i) => exists[i])
      if (found.length) setConfirmed((prev) => new Set([...prev, ...found]))
      if (gone.length) onMissingRef.current(gone)
    })
  }, [listed, recent, projectId])
  const shownRecent = useMemo(
    () => (listed ? recent.filter((p) => listed.has(keyOf(p)) || confirmed.has(p)) : recent),
    [listed, recent, confirmed]
  )

  const { query, line } = parseQuery(text)
  const deferredQuery = useDeferredValue(query)
  const results = useMemo(() => rankFiles(files ?? [], deferredQuery, shownRecent), [files, deferredQuery, shownRecent])
  const current = Math.min(index, Math.max(results.length - 1, 0))

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current, results])

  const cancel = (): void => {
    onClose()
    returnFocus.current?.focus()
  }

  // A listagem é de quando a paleta abriu; o arquivo pode ter sido apagado ou movido desde então.
  const choose = async (rel: string): Promise<void> => {
    const exists = await window.kora.fileExists(projectId, rel).catch(() => false)
    if (exists) return onOpen(rel, line)
    setError(`Arquivo não encontrado: ${rel}`)
    setFiles((list) => list?.filter((p) => p !== rel) ?? list)
    onMissing([rel])
  }

  // Sem item na lista, o texto ainda pode ser um caminho de fora da listagem (absoluto, ignorado pelo git).
  const submit = async (): Promise<void> => {
    const chosen = results[current]
    if (chosen) return choose(chosen)
    if (!text.trim()) return
    const target = await window.kora.resolveTerminalLink(projectId, text.trim()).catch(() => null)
    if (target) onOpen(target.rel, target.line)
    else setError('Arquivo não encontrado neste projeto')
  }

  return (
    <div
      data-quick-open
      className="absolute left-1/2 top-2 z-30 flex max-h-[60%] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 flex-col rounded-lg border bg-card shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Icon name="buscar" className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          aria-label="Ir para arquivo"
          placeholder="Ir para arquivo (nome, caminho ou caminho:linha)"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setIndex(0)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              if (results.length) setIndex((current + step + results.length) % results.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          onBlur={onClose}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div ref={listRef} role="listbox" aria-label="Arquivos" className="min-h-0 overflow-y-auto p-1">
        {results.map((path, i) => {
          const { name, folder } = split(path)
          return (
            <div
              key={path}
              role="option"
              aria-selected={i === current}
              data-index={i}
              // O clique não pode tirar o foco do campo antes de escolher: o blur fecha a paleta.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== current && setIndex(i)}
              onClick={() => void choose(path)}
              className={cn(
                'flex cursor-default items-baseline gap-2 rounded-md px-2 py-1 text-xs',
                i === current ? 'bg-secondary text-foreground' : 'text-foreground/90'
              )}
            >
              <span className="shrink-0">{name}</span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">{folder}</span>
            </div>
          )
        })}
        {files === null && <p className="px-2 py-1 text-xs text-muted-foreground">Listando arquivos…</p>}
        {files !== null && results.length === 0 && !error && (
          <p className="px-2 py-1 text-xs text-muted-foreground">Nenhum arquivo encontrado. Enter tenta abrir o caminho digitado.</p>
        )}
        {error && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
