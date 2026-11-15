import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { Loader } from '@/brand/Logo'
import type { ProjectSearchMatch, ProjectSearchOptions, ProjectSearchResult } from '@shared/ipc'
import type { OpenAtOptions } from '@/lib/file-tabs'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'

const DEBOUNCE_MS = 250

// Pedido de foco no campo (Ctrl+Shift+F, aba Buscar, "Buscar na pasta…"); n muda a cada pedido.
export interface SearchRequest {
  n: number
  query?: string
  include?: string
}

interface Props {
  projectId: string
  request: SearchRequest | null
  reloadKey: number
  onOpenAt(rel: string, line: number | null, opts?: OpenAtOptions): void
  // A busca vive dentro de Arquivos: fechar (Esc com o campo vazio ou o ×) volta para a árvore.
  onClose?(): void
}

type Toggle = 'caseSensitive' | 'wholeWord' | 'regex'
type Toggles = Pick<ProjectSearchOptions, Toggle>

const NO_OPTIONS: Toggles = { caseSensitive: false, wholeWord: false, regex: false }

const OPTIONS: { key: Toggle; label: string; title: string }[] = [
  { key: 'caseSensitive', label: 'Aa', title: 'Diferenciar maiúsculas' },
  { key: 'wholeWord', label: 'ab', title: 'Palavra inteira' },
  { key: 'regex', label: '.*', title: 'Expressão regular' }
]

interface SavedSearch {
  query: string
  opts: Toggles
  include: string
  exclude: string
  showInclude: boolean
  collapsed: Set<string>
  shownKey: string | null
}

// O painel direito desmonta ao fechar e a cada troca de projeto; a busca de cada projeto sobrevive aqui, como no VS Code.
const saved = new Map<string, SavedSearch>()

// Mesmo conjunto que o main escapa: com a flag u, escapar outro caractere é erro de sintaxe.
const escapeRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

// VS Code: Ctrl+Shift+F com uma seleção de uma linha no editor preenche a busca; várias linhas, não.
export async function selectionSeed(): Promise<string | undefined> {
  const active = document.activeElement
  if (active instanceof Element && active.closest('.monaco-editor')) {
    // O editor já está aberto, então o import só devolve o módulo carregado. A seleção não muda quando o foco
    // passa para o campo, por isso basta o elemento guardado antes do await.
    const { monaco } = await import('@/lib/monaco')
    const editor = monaco.editor.getEditors().find((e) => e.getDomNode()?.contains(active))
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    if (!model || !selection || selection.isEmpty() || selection.startLineNumber !== selection.endLineNumber) return undefined
    return model.getValueInRange(selection)
  }
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return undefined
  const text = window.getSelection()?.toString() ?? ''
  return text !== '' && !/[\r\n]/.test(text) ? text : undefined
}

const splitPath = (path: string): { name: string; dir: string } => {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut < 0 ? { name: path, dir: '' } : { name: path.slice(cut + 1), dir: path.slice(0, cut) }
}

const count = (n: number): string => n.toLocaleString('pt-BR')

type Row = { key: string; path: string; match: ProjectSearchMatch | null }

const fileKey = (path: string): string => `f:${path}`
const matchKey = (path: string, line: number, column: number): string => `m:${path}:${line}:${column}`

export function SearchPanel({ projectId, request, reloadKey, onOpenAt, onClose }: Props): React.JSX.Element {
  const [initial] = useState(() => saved.get(projectId))
  const [query, setQuery] = useState(initial?.query ?? '')
  const [opts, setOpts] = useState<Toggles>(initial?.opts ?? NO_OPTIONS)
  const [include, setInclude] = useState(initial?.include ?? '')
  const [exclude, setExclude] = useState(initial?.exclude ?? '')
  const [showInclude, setShowInclude] = useState(initial?.showInclude ?? false)
  const [result, setResult] = useState<ProjectSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(initial?.collapsed ?? new Set())
  const [active, setActive] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const includeRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  // Parâmetros da busca cujos resultados estão na tela: pastas recolhidas só voltam a abrir quando eles mudam.
  const shownKey = useRef<string | null>(initial?.shownKey ?? null)
  const selectPending = useRef(false)

  useEffect(() => {
    saved.set(projectId, { query, opts, include, exclude, showInclude, collapsed, shownKey: shownKey.current })
  })

  useEffect(() => {
    if (!request) return
    if (request.query !== undefined) setQuery(opts.regex ? escapeRegex(request.query) : request.query)
    if (request.include !== undefined) {
      setInclude(request.include)
      setShowInclude(true)
    }
    selectPending.current = true
    inputRef.current?.focus()
    inputRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  // O texto novo só chega ao campo na renderização seguinte ao pedido; selecionar antes perderia a seleção.
  useLayoutEffect(() => {
    if (!selectPending.current) return
    selectPending.current = false
    inputRef.current?.select()
  })

  useEffect(() => {
    const mine = ++seq.current
    if (query === '') {
      setResult(null)
      setError(null)
      setLoading(false)
      // Texto vazio cancela no main a busca que ainda estiver lendo o disco.
      void window.kora.searchProject(projectId, '', NO_OPTIONS).catch(() => {})
      return
    }
    setLoading(true)
    const key = JSON.stringify([query, opts, include, exclude])
    const timer = setTimeout(() => {
      window.kora.searchProject(projectId, query, { ...opts, include, exclude }).then(
        (found) => {
          // null: o main cancelou porque outra busca começou; ela é que vai responder.
          if (mine !== seq.current || found === null) return
          setResult(found)
          setError(null)
          if (shownKey.current !== key) setCollapsed(new Set())
          shownKey.current = key
          setLoading(false)
        },
        (err: unknown) => {
          if (mine !== seq.current) return
          setError(ipcErrorMessage(err))
          setResult(null)
          setLoading(false)
        }
      )
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [projectId, query, opts, include, exclude, reloadKey])

  useEffect(() => () => void window.kora.searchProject(projectId, '', NO_OPTIONS).catch(() => {}), [projectId])

  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const files = result?.files ?? []
  const rows: Row[] = files.flatMap((file) => [
    { key: fileKey(file.path), path: file.path, match: null },
    ...(collapsed.has(file.path) ? [] : file.matches.map((m) => ({ key: matchKey(file.path, m.line, m.column), path: file.path, match: m })))
  ])

  // Como no VS Code: em pré-visualização o foco fica na lista; fixa (Enter, duplo clique) passa o foco ao editor.
  const openMatch = (path: string, m: ProjectSearchMatch, preview: boolean): void =>
    onOpenAt(path, m.line, { column: m.column, length: m.length, ...(preview ? { preview: true, focus: false } : {}) })

  const moveTo = (row: Row | undefined): void => {
    if (!row) return
    setActive(row.key)
    requestAnimationFrame(() =>
      listRef.current?.querySelector(`[data-row="${CSS.escape(row.key)}"]`)?.scrollIntoView({ block: 'nearest' })
    )
  }

  // Teclas da lista de resultados do VS Code: Enter abre fixo, Espaço abre em pré-visualização sem sair da lista.
  const onListKey = (e: React.KeyboardEvent): void => {
    const at = rows.findIndex((r) => r.key === active)
    const row = rows[at]
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'ArrowDown') {
      handled()
      moveTo(rows[at + 1] ?? rows[at] ?? rows[0])
    } else if (e.key === 'ArrowUp') {
      handled()
      if (at <= 0) inputRef.current?.focus()
      else moveTo(rows[at - 1])
    } else if (!row) {
      return
    } else if (e.key === 'Enter' || e.key === ' ') {
      handled()
      if (row.match === null) toggle(row.path)
      else openMatch(row.path, row.match, e.key === ' ')
    } else if (e.key === 'ArrowLeft') {
      handled()
      if (row.match !== null) moveTo(rows.find((r) => r.key === fileKey(row.path)))
      else if (!collapsed.has(row.path)) toggle(row.path)
    } else if (e.key === 'ArrowRight' && row.match === null && collapsed.has(row.path)) {
      handled()
      toggle(row.path)
    }
  }

  const focusList = (): void => {
    if (rows.length === 0) return
    if (!rows.some((r) => r.key === active)) setActive(rows[0]!.key)
    listRef.current?.focus()
  }

  const filterActive = include.trim() !== '' || exclude.trim() !== ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1 px-2 pb-2">
        <div className="flex items-center rounded-md border bg-card focus-within:border-ring">
          <input
            ref={inputRef}
            data-search-input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              } else if (e.key === 'Escape' && onClose) {
                e.stopPropagation()
                onClose()
              } else if (e.key === 'ArrowDown' && rows.length > 0) {
                e.preventDefault()
                focusList()
              }
            }}
            placeholder="Buscar nos arquivos"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent px-2 py-1 text-xs outline-none select-text"
          />
          <div className="flex shrink-0 items-center gap-0.5 pr-1">
            {OPTIONS.map(({ key, label, title }) => (
              <button
                key={key}
                type="button"
                data-tip={title}
                aria-label={title}
                aria-pressed={opts[key]}
                onClick={() => setOpts((o) => ({ ...o, [key]: !o[key] }))}
                className={cn(
                  'rounded px-1 font-mono text-[10px] leading-4',
                  key === 'wholeWord' && 'underline underline-offset-2',
                  opts[key] ? 'bg-secondary text-foreground ring-1 ring-ring' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
            {onClose && (
              <button
                type="button"
                data-tip="Fechar a busca e voltar à árvore"
                data-tip-shortcut="Esc"
                aria-label="Fechar a busca e voltar à árvore"
                onClick={onClose}
                className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Icon name="fechar" className="size-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            data-tip="Alternar detalhes da busca"
            aria-label="Alternar detalhes da busca"
            aria-expanded={showInclude}
            onClick={() => {
              const next = !showInclude
              setShowInclude(next)
              if (next) requestAnimationFrame(() => includeRef.current?.focus())
            }}
            className={cn(
              'rounded px-1 text-[11px] leading-3',
              // Escondido, o filtro continua valendo (como no VS Code): o botão marcado avisa que há um.
              !showInclude && filterActive
                ? 'bg-secondary text-foreground ring-1 ring-ring'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            …
          </button>
        </div>
        {showInclude && (
          <label className="block">
            <span className="block px-0.5 pb-0.5 text-[11px] text-muted-foreground">Arquivos a incluir</span>
            <input
              ref={includeRef}
              data-search-include
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && include) {
                  e.stopPropagation()
                  setInclude('')
                }
              }}
              placeholder="ex.: *.ts, src/**/*.tsx, .\pasta"
              spellCheck={false}
              className="w-full rounded-md border bg-card px-2 py-1 text-xs outline-none focus:border-ring select-text"
            />
          </label>
        )}
        {showInclude && (
          <label className="block">
            <span className="block px-0.5 pb-0.5 text-[11px] text-muted-foreground">Arquivos a excluir</span>
            <input
              data-search-exclude
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && exclude) {
                  e.stopPropagation()
                  setExclude('')
                }
              }}
              placeholder="ex.: dist, *.min.js, .\gerado"
              spellCheck={false}
              className="w-full rounded-md border bg-card px-2 py-1 text-xs outline-none focus:border-ring select-text"
            />
          </label>
        )}
      </div>

      {error && <p className="px-3 pb-2 text-xs break-words text-destructive">{error}</p>}
      {!error && loading && (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
          <Loader size={16} />
          Buscando…
        </div>
      )}
      {!error && !loading && result && (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground">
          {result.total === 0
            ? 'Nenhum resultado.'
            : `${count(result.total)} ${result.total === 1 ? 'resultado' : 'resultados'} em ${count(files.length)} ${files.length === 1 ? 'arquivo' : 'arquivos'}`}
          {result.truncated && (
            <span className="block text-[var(--brand-amber)]">Resultados truncados: refine a busca para ver o resto.</span>
          )}
          {result.capped && (
            <span className="block text-[var(--brand-amber)]">O projeto tem arquivos demais: a busca leu só os primeiros 50.000.</span>
          )}
        </p>
      )}

      <div
        ref={listRef}
        tabIndex={rows.length > 0 ? 0 : -1}
        data-search-results
        data-keeps-focus
        onKeyDown={onListKey}
        onFocus={(e) => {
          if (e.target === e.currentTarget && !rows.some((r) => r.key === active) && rows[0]) setActive(rows[0].key)
        }}
        className="group min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2 outline-none"
      >
        {files.map((file) => {
          const open = !collapsed.has(file.path)
          const { name, dir } = splitPath(file.path)
          const key = fileKey(file.path)
          return (
            <div key={file.path}>
              <div
                data-row={key}
                data-tip={file.path}
                onClick={() => {
                  setActive(key)
                  toggle(file.path)
                }}
                className={cn(
                  'flex h-6 cursor-default items-center gap-1 rounded pr-2 pl-1 text-xs text-foreground/85 hover:bg-secondary/60 hover:text-foreground',
                  active === key && 'group-focus:shadow-[inset_0_0_0_1px_var(--ring)]'
                )}
              >
                <Icon name="expandir" className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
                <Icon name="arquivo" className="size-3.5 shrink-0" />
                <span className="shrink-0 truncate">{name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
                <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">{count(file.matches.length)}</span>
              </div>
              {open &&
                file.matches.map((m) => {
                  const rowKey = matchKey(file.path, m.line, m.column)
                  return (
                    <div
                      key={rowKey}
                      data-row={rowKey}
                      data-tip={`${file.path}:${m.line}:${m.column}`}
                      onClick={() => {
                        setActive(rowKey)
                        openMatch(file.path, m, true)
                      }}
                      onDoubleClick={() => openMatch(file.path, m, false)}
                      className={cn(
                        'flex h-6 cursor-default items-center gap-1.5 rounded pr-2 pl-7 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                        active === rowKey && 'bg-secondary/60 text-foreground group-focus:shadow-[inset_0_0_0_1px_var(--ring)]'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate whitespace-pre">
                        {m.preview.slice(0, m.start)}
                        <span className="rounded-sm bg-[var(--brand-amber)]/30 text-foreground">{m.preview.slice(m.start, m.end)}</span>
                        {m.preview.slice(m.end)}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{m.line}</span>
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
