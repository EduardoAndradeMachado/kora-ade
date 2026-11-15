import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { touchesFile } from '@shared/file-change'
import { Icon } from '@/brand/icons'
import { DELIMITERS, detectDelimiter, detectHeader, parseCsv, type Delimiter } from '@/lib/csv'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { useSaveShortcut } from '@/lib/use-save-shortcut'
import { cn } from '@/lib/utils'
import { openXlsx, XlsxError, type XlsxBook } from '@/lib/xlsx'
import type { Rows } from '@/lib/sheet-view'
import { csvRecordAtLine, sheetJumpFor, type SheetJump } from '@/lib/sheet-jump'
import { ViewerHeader } from '@/components/ViewerHeader'
import { newGridMemory, SheetGrid, type GridGoTo, type GridMemory } from '@/components/SheetGrid'

// Puxa o Monaco: só carrega quando a planilha precisa do texto não salvo do editor.
const LiveSheetView = lazy(() => import('@/components/SheetLive').then((m) => ({ default: m.LiveSheetView })))

export type SheetMode = 'sheet' | 'text'

// CSV e TSV têm o modo Texto (o editor de sempre); o .xlsx é binário e só abre como planilha.
export const isTextSheet = (path: string): boolean => /\.(csv|tsv)$/i.test(path)
const isTsv = (path: string): boolean => /\.tsv$/i.test(path)

// O que a aba lembra enquanto o app está aberto: separador e cabeçalho escolhidos, a folha, e ordem, filtros e
// larguras de cada folha. Trocar para Texto e voltar não perde nada disso.
interface SheetMemory {
  delimiter: Delimiter | null
  header: boolean | null
  sheet: number
  grids: Map<string, GridMemory>
  // Último pedido de ir até uma linha (o `n` do jump da aba) já atendido: a planilha remonta ao voltar do modo Texto
  // e não pode pular de novo para a linha de um Ctrl+clique antigo.
  jumped: number | null
}
const memories = new Map<string, SheetMemory>()
function memoryFor(projectId: string, path: string): SheetMemory {
  const key = `${projectId}\n${path.replace(/\//g, '\\').toLowerCase()}`
  let memory = memories.get(key)
  if (!memory) memories.set(key, (memory = { delimiter: null, header: null, sheet: 0, grids: new Map(), jumped: null }))
  return memory
}

type Jump = { line: number; n: number }

// O pedido de ir até a linha N do arquivo, já traduzido para a linha de dados da grade. target: onde a linha cai
// (null enquanto o arquivo não foi lido); cabeçalho não é linha da grade, vira aviso.
function useSheetJump(memory: SheetMemory, jump: Jump | undefined, target: (line: number) => SheetJump | null, ready: boolean, notify: (text: string) => void): { goTo: GridGoTo | null; onGoTo(n: number): void } {
  const pendingN = jump && jump.n !== memory.jumped ? jump.n : null
  const line = pendingN === null || !ready ? null : jump!.line
  const found = line === null ? null : target(line)
  const header = found?.kind === 'header'
  useEffect(() => {
    if (!header || pendingN === null) return
    memory.jumped = pendingN
    notify(`A linha ${line} do arquivo é o cabeçalho da planilha`)
  }, [header, pendingN, line, memory, notify])
  return {
    goTo: found?.kind === 'row' && line !== null && pendingN !== null ? { row: found.row, line, n: pendingN } : null,
    onGoTo: (n) => {
      memory.jumped = n
    }
  }
}
function gridMemory(memory: SheetMemory, key: string): GridMemory {
  let grid = memory.grids.get(key)
  if (!grid) memory.grids.set(key, (grid = newGridMemory()))
  return grid
}

const tooLargeMessage = (message: string): boolean => message.startsWith('Arquivo grande demais')

export function SheetModeToggle({ mode, onChange }: { mode: SheetMode; onChange(mode: SheetMode): void }): React.JSX.Element {
  const options: { mode: SheetMode; label: string }[] = [
    { mode: 'sheet', label: 'Planilha' },
    { mode: 'text', label: 'Texto' }
  ]
  return (
    <div className="flex shrink-0 items-center rounded-md border bg-card p-0.5">
      {options.map((option) => {
        const active = option.mode === mode
        return (
          <button
            key={option.mode}
            type="button"
            aria-pressed={active}
            onClick={() => !active && onChange(option.mode)}
            className={cn(
              'flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon name={option.mode === 'sheet' ? 'planilha' : 'codigo'} active={active} className="size-3.5" />
            <span className="hidden @md:inline">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

interface ViewProps {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  onOpenPath(rel: string, line: number | null): void
  onModeChange?(mode: SheetMode): void
  // Texto ainda não salvo do editor (modo Texto); sem ele, a planilha mostra o que está no disco.
  live?: string
  // Ctrl+clique em `arquivo.csv:42` no terminal: a linha 42 do arquivo.
  jump?: Jump
}

export function SpreadsheetView(props: ViewProps): React.JSX.Element {
  return isTextSheet(props.path) ? <CsvView {...props} /> : <XlsxView {...props} />
}

function Frame({
  visible,
  header,
  children
}: {
  visible: boolean
  header: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      {header}
      {children}
    </div>
  )
}

function LoadProblem({
  message,
  onForce,
  onOpenExternal
}: {
  message: string
  onForce?(): void
  onOpenExternal(): void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <p className="text-xs text-destructive">{message}</p>
      <div className="flex flex-wrap gap-2">
        {onForce && (
          <button type="button" onClick={onForce} className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">
            Abrir mesmo assim
          </button>
        )}
        <button type="button" onClick={onOpenExternal} className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">
          Abrir no programa padrão
        </button>
      </div>
    </div>
  )
}

function useNotice(): [string | null, (text: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  return [notice, setNotice]
}

function Notice({ text }: { text: string | null }): React.JSX.Element | null {
  if (!text) return null
  return (
    <div role="status" className="pointer-events-none absolute bottom-8 left-1/2 z-40 max-w-[90%] -translate-x-1/2 truncate rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-md">
      {text}
    </div>
  )
}

function HeaderToggle({ checked, detected, onChange }: { checked: boolean; detected: boolean; onChange(next: boolean): void }): React.JSX.Element {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1.5" data-tip={detected ? 'Detectado: a primeira linha parece de rótulos' : 'Detectado: a primeira linha parece de dados'}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--brand-amber)]" />
      1ª linha é cabeçalho
    </label>
  )
}

const widthOf = (rows: Rows): number => rows.reduce((max, row) => Math.max(max, row.length), 0)

function CsvView({ projectId, projectPath, path, visible, onOpenPath, onModeChange, live, jump }: ViewProps): React.JSX.Element {
  const memory = memoryFor(projectId, path)
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [force, setForce] = useState(false)
  const [delimiterChoice, setDelimiterChoice] = useState<Delimiter | null>(memory.delimiter)
  const [headerChoice, setHeaderChoice] = useState<boolean | null>(memory.header)
  const [notice, setNotice] = useNotice()
  const fromDisk = live === undefined

  useEffect(() => {
    if (!fromDisk) return
    let cancelled = false
    window.kora.readText(projectId, path, { force }).then(
      (file) => {
        if (cancelled) return
        setSource(file.content)
        setError(null)
      },
      (err: unknown) => !cancelled && setError(ipcErrorMessage(err))
    )
    return () => {
      cancelled = true
    }
  }, [projectId, path, reloadKey, fromDisk, force])

  const loadedRef = useRef(false)
  useEffect(() => {
    loadedRef.current = source !== null
  }, [source])

  // Só leitura, sem nada a perder: mudou no disco (um agente regravou o CSV), relê. Depois de aberto, continua
  // aberto mesmo que cresça além do limite, como no editor; o que ainda não abriu passa pelo limite de novo.
  useEffect(() => {
    if (!fromDisk) return
    let cancelled = false
    const off = window.kora.onFilesChanged((changedProject, change) => {
      if (changedProject !== projectId || !touchesFile(change, path)) return
      if (!loadedRef.current) return setReloadKey((k) => k + 1)
      window.kora.readText(projectId, path, { force: true }).then(
        (file) => !cancelled && setSource(file.content),
        () => {}
      )
    })
    return () => {
      cancelled = true
      off()
    }
  }, [projectId, path, fromDisk])

  const text = live ?? source
  const tsv = isTsv(path)
  const detected = useMemo(() => (text === null ? ',' : detectDelimiter(text, tsv ? '\t' : ',')), [text, tsv])
  // TSV é tab por definição; a detecção só vale para o .csv, que no Brasil costuma vir com ";".
  const delimiter = delimiterChoice ?? (tsv ? '\t' : detected)
  const all = useMemo(() => (text === null ? [] : parseCsv(text, delimiter)), [text, delimiter])
  const autoHeader = useMemo(() => detectHeader(all), [all])
  const hasHeader = headerChoice ?? autoHeader
  const body = useMemo(() => (hasHeader ? all.slice(1) : all), [all, hasHeader])
  const width = useMemo(() => widthOf(all), [all])
  const gridKey = `${delimiter}|${hasHeader}`
  const { goTo, onGoTo } = useSheetJump(
    memory,
    jump,
    (line) => (text === null ? null : sheetJumpFor(csvRecordAtLine(text, delimiter, line), hasHeader)),
    text !== null,
    setNotice
  )

  const chooseDelimiter = (value: Delimiter | null): void => {
    memory.delimiter = value
    setDelimiterChoice(value)
  }
  const chooseHeader = (value: boolean): void => {
    memory.header = value
    setHeaderChoice(value)
  }

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  const onReload = (): void => {
    if (fromDisk) setReloadKey((k) => k + 1)
    else setNotice('Há alterações não salvas: para recarregar do disco, use o modo Texto')
  }

  const autoLabel = DELIMITERS.find((d) => d.value === (tsv ? '\t' : detected))?.label ?? ''
  const toolbar = (
    <>
      <label className="flex shrink-0 items-center gap-1.5">
        <span className="hidden @sm:inline">Separador</span>
        <select
          aria-label="Separador"
          value={delimiterChoice ?? 'auto'}
          onChange={(e) => chooseDelimiter(e.target.value === 'auto' ? null : (e.target.value as Delimiter))}
          className="h-6 rounded border bg-background px-1 text-foreground outline-none focus:border-[var(--brand-amber)]"
        >
          <option value="auto">Automático ({autoLabel.toLowerCase()})</option>
          {DELIMITERS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <HeaderToggle checked={hasHeader} detected={autoHeader} onChange={chooseHeader} />
    </>
  )

  return (
    <Frame
      visible={visible}
      header={
        <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={onReload}>
          {!fromDisk && (
            <span className="flex shrink-0 items-center gap-1.5 text-amber-300" data-tip="Mostrando as alterações não salvas" data-tip-shortcut="Ctrl+S">
              <span className="size-1.5 rounded-full bg-current" />
              <span className="hidden @lg:inline">Não salvo</span>
            </span>
          )}
          {onModeChange && <SheetModeToggle mode="sheet" onChange={onModeChange} />}
        </ViewerHeader>
      }
    >
      <div className="@container relative flex min-h-0 flex-1 flex-col">
        {error && fromDisk ? (
          <LoadProblem message={error} onForce={tooLargeMessage(error) ? () => setForce(true) : undefined} onOpenExternal={openExternal} />
        ) : text === null ? (
          <p className="p-4 text-xs text-muted-foreground">Carregando…</p>
        ) : (
          <SheetGrid
            key={gridKey}
            rows={body}
            header={hasHeader ? (all[0] ?? null) : null}
            width={width}
            firstRowNumber={hasHeader ? 2 : 1}
            visible={visible}
            memory={gridMemory(memory, gridKey)}
            toolbar={toolbar}
            goTo={goTo}
            onGoTo={onGoTo}
          />
        )}
        <Notice text={notice} />
      </div>
    </Frame>
  )
}

type BookState = { status: 'loading' } | { status: 'ready'; book: XlsxBook } | { status: 'error'; message: string; tooLarge: boolean }
type SheetState = { status: 'loading' } | { status: 'ready'; rows: string[][] } | { status: 'error'; message: string }

const xlsxMessage = (err: unknown): string => (err instanceof XlsxError ? err.message : ipcErrorMessage(err))

function XlsxView({ projectId, projectPath, path, visible, onOpenPath, jump }: ViewProps): React.JSX.Element {
  const memory = memoryFor(projectId, path)
  const [book, setBook] = useState<BookState>({ status: 'loading' })
  const [sheetIndex, setSheetIndex] = useState(memory.sheet)
  const [sheet, setSheet] = useState<SheetState>({ status: 'loading' })
  const [headerChoice, setHeaderChoice] = useState<boolean | null>(memory.header)
  const [reloadKey, setReloadKey] = useState(0)
  const [force, setForce] = useState(false)
  const [notice, setNotice] = useNotice()

  useEffect(() => {
    let cancelled = false
    window.kora
      .readSheetBytes(projectId, path, { force })
      .then((bytes) => openXlsx(bytes))
      .then(
        (opened) => !cancelled && setBook({ status: 'ready', book: opened }),
        (err: unknown) => {
          if (cancelled) return
          const message = xlsxMessage(err)
          setBook({ status: 'error', message, tooLarge: tooLargeMessage(message) })
        }
      )
    return () => {
      cancelled = true
    }
  }, [projectId, path, reloadKey, force])

  useEffect(
    () =>
      window.kora.onFilesChanged((changedProject, change) => {
        if (changedProject === projectId && touchesFile(change, path)) setReloadKey((k) => k + 1)
      }),
    [projectId, path]
  )

  const opened = book.status === 'ready' ? book.book : null
  const index = opened && sheetIndex < opened.sheets.length ? sheetIndex : 0

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    setSheet({ status: 'loading' })
    opened.readSheet(index).then(
      (rows) => !cancelled && setSheet({ status: 'ready', rows }),
      (err: unknown) => !cancelled && setSheet({ status: 'error', message: xlsxMessage(err) })
    )
    return () => {
      cancelled = true
    }
  }, [opened, index])

  const rows = sheet.status === 'ready' ? sheet.rows : null
  const autoHeader = useMemo(() => (rows ? detectHeader(rows) : false), [rows])
  const hasHeader = headerChoice ?? autoHeader
  const body = useMemo(() => (rows ? (hasHeader ? rows.slice(1) : rows) : []), [rows, hasHeader])
  const width = useMemo(() => (rows ? widthOf(rows) : 0), [rows])
  const gridKey = `${index}|${hasHeader}`
  // No .xlsx a "linha do arquivo" é a linha do Excel, na folha aberta.
  const { goTo, onGoTo } = useSheetJump(
    memory,
    jump,
    (line) => (rows && rows.length > 0 ? sheetJumpFor(Math.min(line, rows.length) - 1, hasHeader) : null),
    rows !== null,
    setNotice
  )

  const chooseSheet = (next: number): void => {
    memory.sheet = next
    setSheetIndex(next)
  }
  const chooseHeader = (value: boolean): void => {
    memory.header = value
    setHeaderChoice(value)
  }
  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  const tabs = opened && opened.sheets.length > 1 && (
    <div role="tablist" aria-label="Folhas" className="flex h-7 shrink-0 items-stretch gap-0.5 overflow-x-auto border-t bg-muted px-2 text-xs">
      {opened.sheets.map((s, i) => (
        <button
          key={`${i}:${s.name}`}
          type="button"
          role="tab"
          aria-selected={i === index}
          data-tip={s.hidden ? `${s.name}\nFolha oculta no Excel` : undefined}
          onClick={() => chooseSheet(i)}
          className={cn(
            'shrink-0 whitespace-nowrap border-b-2 px-3 hover:text-foreground',
            i === index ? 'border-[var(--brand-amber)] bg-canvas font-medium text-foreground' : 'border-transparent text-muted-foreground',
            s.hidden && 'italic opacity-70'
          )}
        >
          {s.name}
        </button>
      ))}
    </div>
  )

  return (
    <Frame
      visible={visible}
      header={<ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={() => setReloadKey((k) => k + 1)} onOpenExternal={openExternal} />}
    >
      <div className="@container relative flex min-h-0 flex-1 flex-col">
        {book.status === 'error' ? (
          <LoadProblem message={book.message} onForce={book.tooLarge ? () => setForce(true) : undefined} onOpenExternal={openExternal} />
        ) : book.status === 'loading' || sheet.status === 'loading' ? (
          <p className="p-4 text-xs text-muted-foreground">Lendo a planilha…</p>
        ) : sheet.status === 'error' ? (
          <>
            <LoadProblem message={sheet.message} onOpenExternal={openExternal} />
            <span className="flex-1" />
            {tabs}
          </>
        ) : (
          <SheetGrid
            key={gridKey}
            rows={body}
            header={hasHeader && rows ? (rows[0] ?? null) : null}
            width={width}
            firstRowNumber={hasHeader ? 2 : 1}
            visible={visible}
            memory={gridMemory(memory, gridKey)}
            toolbar={<HeaderToggle checked={hasHeader} detected={autoHeader} onChange={chooseHeader} />}
            footer={tabs}
            goTo={goTo}
            onGoTo={onGoTo}
          />
        )}
        <Notice text={notice} />
      </div>
    </Frame>
  )
}

interface TabProps extends Omit<ViewProps, 'live' | 'onModeChange'> {
  mode: SheetMode
  dirty: boolean
  onModeChange(mode: SheetMode): void
  // O CodeView da aba (CSV/TSV), ou null quando ele não precisa existir (Planilha sem nada por salvar).
  editor: React.ReactNode
  onSave?(): void
}

// Como no Markdown: o editor fica montado (escondido) enquanto há alteração não salva, porque desmontar
// descartaria o model do Monaco, e a planilha lê o texto dele.
export function SheetTab({ editor, mode, dirty, visible, onSave, onModeChange, ...view }: TabProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const textual = isTextSheet(view.path)
  useSaveShortcut(visible && mode === 'sheet' && dirty, onSave)
  // Pedido que chegou no modo Texto foi atendido pelo editor; voltar para a Planilha depois não pula de novo.
  const jumpN = view.jump?.n
  useEffect(() => {
    if (mode === 'text' && jumpN !== undefined) memoryFor(view.projectId, view.path).jumped = jumpN
  }, [mode, jumpN, view.projectId, view.path])
  const fallback = <div className="absolute inset-0 bg-canvas" />
  return (
    <div className={cn('absolute inset-0', !visible && 'invisible')}>
      <div ref={hostRef} className={cn('absolute inset-0', mode === 'sheet' && 'invisible')}>
        {editor}
      </div>
      {mode === 'sheet' &&
        (textual && dirty ? (
          <Suspense fallback={fallback}>
            <LiveSheetView {...view} visible={visible} onModeChange={onModeChange} editorHost={hostRef} />
          </Suspense>
        ) : (
          <SpreadsheetView {...view} visible={visible} onModeChange={textual ? onModeChange : undefined} />
        ))}
    </div>
  )
}
