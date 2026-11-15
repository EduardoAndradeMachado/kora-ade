import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { cn } from '@/lib/utils'
import { formatNumber, parseNumber } from '@/lib/sheet-value'
import { filterRows, findMatches, isFilterActive, sortRows, type ColumnFilter, type Match, type Rows, type SortSpec } from '@/lib/sheet-view'
import { columnLabel, inRange, rangeOf, selectionStats, selectionTsv, type CellPos, type Selection, type SelectionStats } from '@/lib/sheet-select'
import { SheetFilterMenu } from '@/components/SheetFilterMenu'

const ROW_H = 22
const LETTER_H = 18
const NAME_H = 24
const HEAD_H = LETTER_H + NAME_H
const MIN_W = 36
const MAX_AUTO_W = 320
const MAX_FIT_W = 800
const PAD = 14
// Rótulo do cabeçalho em negrito, mais a seta de ordenação e o botão de filtro.
const HEADER_EXTRA = 52
const OVERSCAN_ROWS = 8
const OVERSCAN_PX = 240
// Acima disso a soma da seleção é feita aos pedaços, sem travar a janela (Ctrl+A numa planilha de milhões de células).
const SYNC_STATS_CELLS = 200_000
const STATS_CHUNK_CELLS = 100_000
const SEARCH_DELAY_MS = 150

const formatStat = (value: number): string => value.toLocaleString('pt-BR', { maximumFractionDigits: 4 })

// O que a planilha lembra ao trocar para Texto e voltar, ou ao trocar de folha: vive enquanto o app estiver aberto.
export interface GridMemory {
  sort: SortSpec | null
  filters: Map<number, ColumnFilter>
  widths: Map<number, number>
}

export const newGridMemory = (): GridMemory => ({ sort: null, filters: new Map(), widths: new Map() })

// Ir até uma linha de dados (índice em `rows`, antes de filtro e ordem); line é a do arquivo, para o aviso.
export interface GridGoTo {
  row: number
  line: number
  n: number
}

interface Props {
  rows: Rows
  header: readonly string[] | null
  width: number
  // Número da linha do arquivo da primeira linha de dados (2 com cabeçalho, como no Excel).
  firstRowNumber: number
  visible: boolean
  memory: GridMemory
  toolbar?: React.ReactNode
  footer?: React.ReactNode
  goTo?: GridGoTo | null
  // Chamado uma vez por pedido atendido (achou a linha ou avisou que o filtro a esconde).
  onGoTo?(n: number): void
}

let measureContext: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return text.length * 7
  if (measureContext.font !== font) measureContext.font = font
  return measureContext.measureText(text.length > 200 ? text.slice(0, 200) : text).width
}

const gridFont = (): string => `12px ${getComputedStyle(document.body).fontFamily}`

// Largura pelo conteúdo de uma amostra (o começo da planilha), como o Excel faz ao abrir um CSV.
function autoWidths(rows: Rows, header: readonly string[] | null, width: number): number[] {
  const font = gridFont()
  const sample = Math.min(rows.length, Math.max(50, Math.min(1000, Math.floor(200_000 / Math.max(1, width)))))
  const out: number[] = []
  for (let c = 0; c < width; c++) {
    let w = Math.max(textWidth(header?.[c] ?? `Coluna ${columnLabel(c)}`, font) + HEADER_EXTRA, 56)
    for (let r = 0; r < sample; r++) {
      const cell = rows[r]?.[c]
      if (cell) w = Math.max(w, textWidth(cell, font) + PAD)
      if (w >= MAX_AUTO_W) break
    }
    out.push(Math.min(MAX_AUTO_W, Math.ceil(w)))
  }
  return out
}

// Duplo clique na borda: a coluna toda, não só a amostra. Medir 200 mil textos levaria segundos; os mais compridos
// em caracteres são os candidatos a mais largos.
function fitWidth(rows: Rows, view: readonly number[], header: readonly string[] | null, col: number): number {
  const font = gridFont()
  const longest: string[] = []
  let floor = 0
  for (const index of view) {
    const cell = rows[index]?.[col]
    if (!cell || cell.length < floor) continue
    longest.push(cell)
    if (longest.length > 64) {
      longest.sort((a, b) => b.length - a.length)
      longest.length = 32
      floor = longest[31]!.length
    }
  }
  let w = textWidth(header?.[col] ?? `Coluna ${columnLabel(col)}`, font) + HEADER_EXTRA
  for (const cell of longest) w = Math.max(w, textWidth(cell, font) + PAD)
  return Math.min(MAX_FIT_W, Math.max(MIN_W, Math.ceil(w)))
}

function upperBound(lefts: Float64Array, x: number): number {
  let lo = 0
  let hi = lefts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lefts[mid]! <= x) lo = mid
    else hi = mid - 1
  }
  return lo
}

type Drag = { kind: 'cells' | 'cols' | 'rows'; pointerId: number }

export function SheetGrid({ rows, header, width, firstRowNumber, visible, memory, toolbar, footer, goTo, onGoTo }: Props): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [sort, setSortState] = useState<SortSpec | null>(memory.sort)
  const [filters, setFiltersState] = useState<Map<number, ColumnFilter>>(memory.filters)
  const [widths, setWidthsState] = useState<Map<number, number>>(memory.widths)
  const [selection, setSelection] = useState<Selection>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 0, width: 0 })
  const [filterMenu, setFilterMenu] = useState<{ col: number; rect: DOMRect } | null>(null)
  const [search, setSearch] = useState<{ open: boolean; query: string }>({ open: false, query: '' })
  const [matches, setMatches] = useState<Match[]>([])
  const [matchIndex, setMatchIndex] = useState(-1)
  const [stats, setStats] = useState<SelectionStats | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const dragRef = useRef<Drag | null>(null)

  const setSort = (next: SortSpec | null): void => {
    memory.sort = next
    setSortState(next)
  }
  const setFilters = (next: Map<number, ColumnFilter>): void => {
    memory.filters = next
    setFiltersState(next)
  }
  const setWidth = (col: number, w: number): void => {
    const next = new Map(widths)
    next.set(col, Math.max(MIN_W, Math.round(w)))
    memory.widths = next
    setWidthsState(next)
  }

  const view = useMemo(() => {
    const kept = filterRows(rows, filters)
    return sort && sort.col < width ? sortRows(rows, kept, sort) : kept
  }, [rows, filters, sort, width])

  const auto = useMemo(() => autoWidths(rows, header, width), [rows, header, width])
  const cellFont = useMemo(gridFont, [])
  const lefts = useMemo(() => {
    const out = new Float64Array(width + 1)
    for (let c = 0; c < width; c++) out[c + 1] = out[c]! + (widths.get(c) ?? auto[c] ?? 100)
    return out
  }, [auto, widths, width])
  const rowNumW = Math.max(40, String(rows.length + firstRowNumber).length * 7 + 18)
  const totalW = rowNumW + lefts[width]!
  const totalH = HEAD_H + view.length * ROW_H
  const lastRow = view.length - 1
  const lastCol = width - 1

  // A seleção fica dentro da vista quando um filtro some com linhas.
  const clamp = (p: CellPos): CellPos => ({ row: Math.max(0, Math.min(lastRow, p.row)), col: Math.max(0, Math.min(lastCol, p.col)) })
  const sel: Selection = { anchor: clamp(selection.anchor), focus: clamp(selection.focus) }
  const range = rangeOf(sel)
  const empty = view.length === 0 || width === 0

  const measureViewport = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    setViewport((v) =>
      v.top === el.scrollTop && v.left === el.scrollLeft && v.height === el.clientHeight && v.width === el.clientWidth
        ? v
        : { top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight, width: el.clientWidth }
    )
  }, [])

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    measureViewport()
    const observer = new ResizeObserver(measureViewport)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measureViewport])

  useEffect(() => {
    if (visible) scrollerRef.current?.focus({ preventScroll: true })
  }, [visible])

  const firstVisible = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN_ROWS)
  const lastVisible = Math.min(lastRow, Math.ceil((viewport.top + viewport.height - HEAD_H) / ROW_H) + OVERSCAN_ROWS)
  const firstCol = width === 0 ? 0 : Math.min(lastCol, upperBound(lefts, Math.max(0, viewport.left - OVERSCAN_PX)))
  const lastColVisible = width === 0 ? -1 : Math.min(lastCol, upperBound(lefts, viewport.left + viewport.width - rowNumW + OVERSCAN_PX))

  const reveal = (p: CellPos): void => {
    const el = scrollerRef.current
    if (!el) return
    const top = HEAD_H + p.row * ROW_H
    if (top - HEAD_H < el.scrollTop) el.scrollTop = top - HEAD_H
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
    const left = lefts[p.col]!
    const right = lefts[p.col + 1]!
    const room = el.clientWidth - rowNumW
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (right > el.scrollLeft + room) el.scrollLeft = Math.min(left, right - room)
  }

  const select = (next: Selection, show = true): void => {
    setSelection(next)
    if (show) reveal(next.focus)
  }

  // Ctrl+clique em `dados.csv:42`: a linha inteira selecionada, no meio da tela, com o foco na primeira coluna. A grade
  // mostra a linha pela posição na vista (filtro e ordem), então a linha do arquivo é procurada nela.
  const handledGoTo = useRef<number | null>(null)
  useEffect(() => {
    if (!goTo || handledGoTo.current === goTo.n) return
    handledGoTo.current = goTo.n
    onGoTo?.(goTo.n)
    const v = view.indexOf(goTo.row)
    if (v < 0) {
      setNotice(`A linha ${goTo.line} do arquivo está escondida pelos filtros`)
      return
    }
    setSelection({ anchor: { row: v, col: Math.max(0, lastCol) }, focus: { row: v, col: 0 } })
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = Math.max(0, v * ROW_H - (el.clientHeight - HEAD_H - ROW_H) / 2)
    el.scrollLeft = 0
    el.focus({ preventScroll: true })
  }, [goTo, onGoTo, view, lastCol])

  // ------------------------------------------------------------ estatística da seleção

  const { top: rangeTop, left: rangeLeft, bottom: rangeBottom, right: rangeRight } = range
  useEffect(() => {
    const cols = rangeRight - rangeLeft + 1
    const cells = (rangeBottom - rangeTop + 1) * cols
    const whole = { top: rangeTop, left: rangeLeft, bottom: rangeBottom, right: rangeRight }
    if (empty || cells <= 1) {
      setStats(null)
      return
    }
    if (cells <= SYNC_STATS_CELLS) {
      setStats(selectionStats(rows, view, whole))
      return
    }
    setStats(null)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const total: SelectionStats = { count: 0, numbers: 0, sum: 0 }
    const step = Math.max(1, Math.floor(STATS_CHUNK_CELLS / cols))
    let top = rangeTop
    const run = (): void => {
      if (cancelled) return
      const bottom = Math.min(rangeBottom, top + step - 1)
      const part = selectionStats(rows, view, { ...whole, top, bottom })
      total.count += part.count
      total.numbers += part.numbers
      total.sum += part.sum
      top = bottom + 1
      if (top > rangeBottom) setStats({ ...total })
      else timer = setTimeout(run, 0)
    }
    timer = setTimeout(run, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [rows, view, rangeTop, rangeLeft, rangeBottom, rangeRight, empty])

  // ------------------------------------------------------------ busca

  useEffect(() => {
    if (!search.open || search.query.trim() === '') {
      setMatches([])
      setMatchIndex(-1)
      return
    }
    const timer = setTimeout(() => {
      const found = findMatches(rows, view, width, search.query)
      setMatches(found)
      if (found.length === 0) {
        setMatchIndex(-1)
        return
      }
      // A partir da célula atual, como o Ctrl+F do VS Code a partir do cursor.
      const { row, col } = selection.focus
      const next = found.findIndex((m) => m.row > row || (m.row === row && m.col >= col))
      const index = next < 0 ? 0 : next
      setMatchIndex(index)
      const m = found[index]!
      select({ anchor: m, focus: m })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
    // A célula de partida é a do momento em que a busca muda, não uma razão para buscar de novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.open, search.query, rows, view, width])

  const matchKeys = useMemo(() => new Set(matches.map((m) => m.row * width + m.col)), [matches, width])
  const current = matchIndex >= 0 ? matches[matchIndex] : undefined

  const stepMatch = (delta: number): void => {
    if (matches.length === 0) return
    const index = (matchIndex + delta + matches.length) % matches.length
    setMatchIndex(index)
    const m = matches[index]!
    select({ anchor: m, focus: m })
  }

  const openSearch = (): void => {
    setSearch((s) => ({ ...s, open: true }))
    requestAnimationFrame(() => {
      searchRef.current?.focus()
      searchRef.current?.select()
    })
  }

  const closeSearch = (): void => {
    setSearch((s) => ({ ...s, open: false }))
    scrollerRef.current?.focus()
  }

  // Ctrl+F da aba visível, como o do editor do VS Code. Campo de texto, terminal e editor de fora da planilha
  // ficam com a tecla.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.code !== 'KeyF') return
      const focused = document.activeElement
      const inside = !!focused && !!rootRef.current?.contains(focused)
      const typing =
        focused instanceof HTMLElement &&
        (focused.isContentEditable || focused.matches('input, textarea, select') || !!focused.closest('.xterm, .monaco-editor'))
      if (!inside && typing) return
      e.preventDefault()
      setSearch((s) => ({ ...s, open: true }))
      requestAnimationFrame(() => {
        searchRef.current?.focus()
        searchRef.current?.select()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  // ------------------------------------------------------------ teclado e cópia

  const copySelection = (): void => {
    if (empty) return
    const text = selectionTsv(rows, view, range, header)
    navigator.clipboard.writeText(text).then(
      () => {
        const cells = (range.bottom - range.top + 1) * (range.right - range.left + 1)
        setNotice(cells === 1 ? 'Célula copiada' : `${formatNumber(cells)} células copiadas`)
      },
      () => setNotice('Não deu para copiar')
    )
  }

  const selectAll = (): void => {
    if (empty) return
    select({ anchor: { row: 0, col: 0 }, focus: { row: lastRow, col: lastCol } }, false)
  }

  const onGridKey = (e: React.KeyboardEvent): void => {
    if (empty) return
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.code === 'KeyC') {
      e.preventDefault()
      copySelection()
      return
    }
    if (ctrl && e.code === 'KeyA') {
      e.preventDefault()
      selectAll()
      return
    }
    const page = Math.max(1, Math.floor((viewport.height - HEAD_H) / ROW_H) - 1)
    const f = sel.focus
    let next: CellPos | null = null
    switch (e.key) {
      case 'ArrowUp':
        next = { row: ctrl ? 0 : f.row - 1, col: f.col }
        break
      case 'ArrowDown':
        next = { row: ctrl ? lastRow : f.row + 1, col: f.col }
        break
      case 'ArrowLeft':
        next = { row: f.row, col: ctrl ? 0 : f.col - 1 }
        break
      case 'ArrowRight':
        next = { row: f.row, col: ctrl ? lastCol : f.col + 1 }
        break
      case 'PageUp':
        next = { row: f.row - page, col: f.col }
        break
      case 'PageDown':
        next = { row: f.row + page, col: f.col }
        break
      case 'Home':
        next = ctrl ? { row: 0, col: 0 } : { row: f.row, col: 0 }
        break
      case 'End':
        next = ctrl ? { row: lastRow, col: lastCol } : { row: f.row, col: lastCol }
        break
      case 'Enter':
        next = { row: f.row + (e.shiftKey ? -1 : 1), col: f.col }
        break
      case 'Escape':
        if (search.open) closeSearch()
        else select({ anchor: f, focus: f }, false)
        return
      default:
        return
    }
    e.preventDefault()
    const focus = clamp(next)
    select({ anchor: e.shiftKey && e.key !== 'Enter' ? sel.anchor : focus, focus })
  }

  // ------------------------------------------------------------ mouse

  const hit = (clientX: number, clientY: number): CellPos => {
    const el = scrollerRef.current!
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left + el.scrollLeft - rowNumW
    const y = clientY - rect.top + el.scrollTop - HEAD_H
    return clamp({ row: Math.floor(y / ROW_H), col: x < 0 ? 0 : upperBound(lefts, x) })
  }

  // Arrastando para fora da grade, ela rola junto (um passo por movimento do mouse).
  const autoScroll = (clientX: number, clientY: number): void => {
    const el = scrollerRef.current!
    const rect = el.getBoundingClientRect()
    if (clientY > rect.bottom - 6) el.scrollTop += ROW_H
    else if (clientY < rect.top + HEAD_H) el.scrollTop -= ROW_H
    if (clientX > rect.right - 6) el.scrollLeft += 40
    else if (clientX < rect.left + rowNumW) el.scrollLeft -= 40
  }

  const startDrag = (e: React.PointerEvent, kind: Drag['kind'], anchor: CellPos, focus: CellPos): void => {
    if (e.button !== 0) return
    e.preventDefault()
    scrollerRef.current?.focus()
    scrollerRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { kind, pointerId: e.pointerId }
    select({ anchor: e.shiftKey ? sel.anchor : anchor, focus }, false)
  }

  const onBodyPointerDown = (e: React.PointerEvent): void => {
    const el = scrollerRef.current
    if (empty || !el) return
    // Clique na barra de rolagem não é clique em célula.
    const rect = el.getBoundingClientRect()
    if (e.clientX - rect.left >= el.clientWidth || e.clientY - rect.top >= el.clientHeight) return
    const p = hit(e.clientX, e.clientY)
    startDrag(e, 'cells', p, p)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    autoScroll(e.clientX, e.clientY)
    const p = hit(e.clientX, e.clientY)
    const focus = drag.kind === 'cols' ? { row: lastRow, col: p.col } : drag.kind === 'rows' ? { row: p.row, col: lastCol } : p
    setSelection((s) => (s.focus.row === focus.row && s.focus.col === focus.col ? s : { anchor: s.anchor, focus }))
  }

  const endPointer = (e: React.PointerEvent): void => {
    dragRef.current = null
    if (scrollerRef.current?.hasPointerCapture(e.pointerId)) scrollerRef.current.releasePointerCapture(e.pointerId)
  }

  // Sem captura do ponteiro: com ela, o duplo clique (ajustar ao conteúdo) iria para a grade em vez da borda.
  const startResize = (col: number, startX: number, startW: number): void => {
    const onMove = (e: PointerEvent): void => setWidth(col, startW + e.clientX - startX)
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const cycleSort = (col: number): void => {
    if (sort?.col !== col) setSort({ col, dir: 'asc' })
    else if (sort.dir === 'asc') setSort({ col, dir: 'desc' })
    else setSort(null)
  }

  const setColumnFilter = (col: number, filter: ColumnFilter | null): void => {
    const next = new Map(filters)
    if (filter && isFilterActive(filter)) next.set(col, filter)
    else next.delete(col)
    setFilters(next)
  }

  const activeFilters = [...filters.values()].filter(isFilterActive).length
  const menuCol = filterMenu?.col
  const menuCandidates = useMemo(() => (menuCol === undefined ? [] : filterRows(rows, filters, menuCol)), [rows, filters, menuCol])
  const label = (c: number): string => header?.[c] || `Coluna ${columnLabel(c)}`

  // ------------------------------------------------------------ desenho

  const headerCells: React.ReactNode[] = []
  const bodyRows: React.ReactNode[] = []
  if (!empty) {
    for (let c = firstCol; c <= lastColVisible; c++) {
      const w = lefts[c + 1]! - lefts[c]!
      const colSelected = c >= range.left && c <= range.right
      const sorted = sort?.col === c ? sort.dir : null
      const filtered = isFilterActive(filters.get(c))
      headerCells.push(
        <div key={c} className="absolute top-0 border-r border-b" style={{ left: rowNumW + lefts[c]!, width: w, height: HEAD_H }}>
          <div
            onPointerDown={(e) => startDrag(e, 'cols', { row: 0, col: c }, { row: lastRow, col: c })}
            className={cn(
              'flex items-center justify-center border-b text-[10px] text-muted-foreground',
              colSelected && 'bg-[var(--brand-amber)]/15 text-foreground'
            )}
            style={{ height: LETTER_H }}
          >
            {columnLabel(c)}
          </div>
          <div className="flex items-center gap-0.5 pl-1.5 pr-1" style={{ height: NAME_H }}>
            <button
              type="button"
              onClick={() => cycleSort(c)}
              data-tip={`${label(c)}\nClique para ordenar: crescente, decrescente, sem ordem`}
              className={cn('flex min-w-0 flex-1 items-center gap-1 text-left font-medium', !header?.[c] && 'font-normal italic text-muted-foreground')}
            >
              <span className="truncate">{label(c)}</span>
              {sorted && <Icon name={sorted === 'asc' ? 'setaCima' : 'setaBaixo'} className="size-3 shrink-0 text-[var(--brand-amber)]" />}
            </button>
            <button
              type="button"
              aria-label={`Filtrar ${label(c)}`}
              data-tip={filtered ? 'Filtro ativo nesta coluna' : 'Filtrar esta coluna'}
              onClick={(e) => setFilterMenu({ col: c, rect: e.currentTarget.getBoundingClientRect() })}
              className={cn(
                'shrink-0 rounded p-0.5 hover:bg-secondary hover:text-foreground',
                filtered ? 'text-[var(--brand-amber)]' : 'text-muted-foreground/70'
              )}
            >
              <FunnelIcon active={filtered} />
            </button>
          </div>
          <div
            role="separator"
            aria-label={`Largura da coluna ${columnLabel(c)}`}
            data-tip="Arraste para mudar a largura; duplo clique ajusta ao conteúdo"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              startResize(c, e.clientX, w)
            }}
            onDoubleClick={() => setWidth(c, fitWidth(rows, view, header, c))}
            className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-[var(--brand-amber)]/40"
          />
        </div>
      )
    }

    for (let v = firstVisible; v <= lastVisible; v++) {
      const source = view[v]!
      const row = rows[source]
      const rowSelected = v >= range.top && v <= range.bottom
      const cells: React.ReactNode[] = []
      for (let c = firstCol; c <= lastColVisible; c++) {
        const text = row?.[c] ?? ''
        const w = lefts[c + 1]! - lefts[c]!
        const selected = inRange(range, v, c)
        const isFocus = sel.focus.row === v && sel.focus.col === c
        const matched = matchKeys.has(v * width + c)
        const isCurrent = current?.row === v && current.col === c
        const numeric = text !== '' && parseNumber(text) !== null
        cells.push(
          <div
            key={c}
            data-tip={text && textWidth(text, cellFont) > w - PAD ? text : undefined}
            className={cn(
              'absolute top-0 truncate border-r border-b px-1.5 leading-[21px]',
              numeric && 'text-right tabular-nums',
              selected && !isFocus && 'bg-[var(--brand-amber)]/10',
              matched && 'bg-[var(--brand-amber)]/30',
              isCurrent && 'bg-[var(--brand-amber)]/55',
              isFocus && 'shadow-[inset_0_0_0_1.5px_var(--brand-amber)]'
            )}
            style={{ left: rowNumW + lefts[c]!, width: w, height: ROW_H }}
          >
            {text}
          </div>
        )
      }
      bodyRows.push(
        <div key={v} className="absolute left-0" style={{ top: HEAD_H + v * ROW_H, width: totalW, height: ROW_H }}>
          <div
            onPointerDown={(e) => {
              e.stopPropagation()
              startDrag(e, 'rows', { row: v, col: 0 }, { row: v, col: lastCol })
            }}
            className={cn(
              'sticky left-0 z-10 border-r border-b bg-muted px-1.5 text-right text-[11px] leading-[21px] text-muted-foreground tabular-nums',
              rowSelected && 'bg-[color-mix(in_oklab,var(--brand-amber)_15%,var(--muted))] text-foreground'
            )}
            style={{ width: rowNumW, height: ROW_H }}
          >
            {source + firstRowNumber}
          </div>
          {cells}
        </div>
      )
    }
  }

  const focusText = empty ? '' : (rows[view[sel.focus.row]!]?.[sel.focus.col] ?? '')
  const refText = empty
    ? ''
    : range.top === range.bottom && range.left === range.right
      ? `${columnLabel(sel.focus.col)}${view[sel.focus.row]! + firstRowNumber}`
      : `${range.bottom - range.top + 1} × ${range.right - range.left + 1}`

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1 text-xs text-muted-foreground">
        {toolbar}
        <span className="shrink-0 tabular-nums" data-tip={activeFilters ? 'Linhas que passam nos filtros, de todas as linhas' : undefined}>
          {activeFilters ? `${formatNumber(view.length)} de ${formatNumber(rows.length)} linhas` : `${formatNumber(rows.length)} linhas`}
        </span>
        {activeFilters > 0 && (
          <button type="button" onClick={() => setFilters(new Map())} className="shrink-0 rounded-md border px-2 py-0.5 hover:bg-secondary hover:text-foreground">
            Limpar filtros
          </button>
        )}
        {sort && (
          <button type="button" onClick={() => setSort(null)} className="shrink-0 rounded-md border px-2 py-0.5 hover:bg-secondary hover:text-foreground">
            Ordem do arquivo
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Buscar na planilha"
          data-tip="Buscar na planilha"
          data-tip-shortcut="Ctrl+F"
          onClick={openSearch}
          className="shrink-0 rounded-md p-1 hover:bg-secondary hover:text-foreground"
        >
          <Icon name="buscar" className="size-3.5" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          tabIndex={0}
          role="grid"
          aria-rowcount={view.length}
          aria-colcount={width}
          onScroll={measureViewport}
          onKeyDown={onGridKey}
          onPointerDown={onBodyPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          className="absolute inset-0 overflow-auto text-xs outline-none select-none"
        >
          {empty ? (
            <p className="p-4 text-muted-foreground">{rows.length === 0 ? 'Planilha vazia.' : 'Nenhuma linha passa nos filtros.'}</p>
          ) : (
            <div className="relative" style={{ width: totalW, height: totalH }}>
              <div className="sticky top-0 z-20 bg-muted" style={{ width: totalW, height: HEAD_H }} onPointerDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  aria-label="Selecionar tudo"
                  data-tip="Selecionar tudo"
                  data-tip-shortcut="Ctrl+A"
                  onClick={selectAll}
                  className="sticky left-0 z-10 block border-r border-b bg-muted hover:bg-secondary"
                  style={{ width: rowNumW, height: HEAD_H }}
                />
                {headerCells}
              </div>
              {bodyRows}
            </div>
          )}
        </div>

        {search.open && (
          <div className="absolute top-2 right-4 z-30 flex max-w-[calc(100%-2rem)] items-center gap-1 rounded-md border bg-card p-1 text-xs shadow-lg">
            <input
              ref={searchRef}
              aria-label="Texto a buscar"
              placeholder="Buscar"
              spellCheck={false}
              value={search.query}
              onChange={(e) => setSearch({ open: true, query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  stepMatch(e.shiftKey && e.key === 'Enter' ? -1 : 1)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  stepMatch(-1)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeSearch()
                }
              }}
              className="h-6 w-40 min-w-0 rounded border bg-background px-1.5 text-foreground outline-none focus:border-[var(--brand-amber)]"
            />
            <span className={cn('shrink-0 px-1 tabular-nums', search.query.trim() && matches.length === 0 ? 'text-destructive' : 'text-muted-foreground')}>
              {search.query.trim() === ''
                ? ''
                : matches.length === 0
                  ? 'Nenhum resultado'
                  : `${formatNumber(matchIndex + 1)} de ${formatNumber(matches.length)}${matches.length >= 100_000 ? '+' : ''}`}
            </span>
            <button type="button" aria-label="Anterior" data-tip="Anterior" data-tip-shortcut="Shift+Enter" onClick={() => stepMatch(-1)} className="rounded p-1 hover:bg-secondary">
              <Icon name="setaCima" className="size-3.5" />
            </button>
            <button type="button" aria-label="Próximo" data-tip="Próximo" data-tip-shortcut="Enter" onClick={() => stepMatch(1)} className="rounded p-1 hover:bg-secondary">
              <Icon name="setaBaixo" className="size-3.5" />
            </button>
            <button type="button" aria-label="Fechar busca" data-tip="Fechar" data-tip-shortcut="Esc" onClick={closeSearch} className="rounded p-1 hover:bg-secondary">
              <Icon name="fechar" className="size-3.5" />
            </button>
          </div>
        )}

        {notice && (
          <div role="status" className="pointer-events-none absolute bottom-3 left-1/2 z-30 max-w-[90%] -translate-x-1/2 truncate rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-md">
            {notice}
          </div>
        )}
      </div>

      {footer}

      <div className="flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t px-3 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground tabular-nums">{refText}</span>
        <span className="min-w-0 flex-1 truncate" data-tip={focusText.length > 40 ? focusText : undefined}>
          {focusText}
        </span>
        {stats && stats.count > 1 && (
          <span className="flex shrink-0 gap-3 tabular-nums">
            {stats.numbers > 0 && <span className="hidden sm:inline">Média: {formatStat(stats.sum / stats.numbers)}</span>}
            <span>Contagem: {formatNumber(stats.count)}</span>
            {stats.numbers > 0 && <span>Soma: {formatStat(stats.sum)}</span>}
          </span>
        )}
      </div>

      {filterMenu && (
        <SheetFilterMenu
          rows={rows}
          candidates={menuCandidates}
          col={filterMenu.col}
          label={label(filterMenu.col)}
          anchor={filterMenu.rect}
          filter={filters.get(filterMenu.col)}
          sort={sort?.col === filterMenu.col ? sort.dir : null}
          onSort={(dir) => setSort(dir ? { col: filterMenu.col, dir } : null)}
          onChange={(filter) => setColumnFilter(filterMenu.col, filter)}
          onClose={() => setFilterMenu(null)}
        />
      )}
    </div>
  )
}

function FunnelIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.35 : undefined} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3">
      <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" />
    </svg>
  )
}

