import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { detectHeader } from '@/lib/csv'
import { columnLabel } from '@/lib/sheet-select'
import { columnKind } from '@/lib/sheet-value'
import { findMatches, type Rows } from '@/lib/sheet-view'
import { sheetJumpFor } from '@/lib/sheet-jump'
import { copyText } from './CopyActions'

// Grade da planilha no celular: o cabeçalho e o número da linha ficam presos enquanto se rola nos dois sentidos, e só
// as linhas perto da tela existem no DOM (planilha de 100 mil linhas abre como uma de 100). Tocar numa célula mostra
// o valor inteiro embaixo, com Copiar.
const ROW = 32
const NUMBER_COLUMN = 48
const OVERSCAN = 10
// Largura pelo texto das primeiras linhas: o bastante para ler a maior parte sem que uma célula longa empurre o resto.
const SAMPLE = 200
const CHAR_PX = 7.4
const MIN_COLUMN = 56
const MAX_COLUMN = 220

function columnWidths(header: readonly string[] | null, rows: Rows, width: number): number[] {
  return Array.from({ length: width }, (_, col) => {
    let longest = header?.[col]?.length ?? columnLabel(col).length
    for (let r = 0; r < Math.min(rows.length, SAMPLE); r++) longest = Math.max(longest, rows[r]?.[col]?.length ?? 0)
    return Math.round(Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, longest * CHAR_PX + 18)))
  })
}

export interface SheetTab { name: string; hidden: boolean }

// all: todas as linhas lidas (o cabeçalho, se houver, é a primeira). jumpRecord: o registro pedido pelo `arquivo:42`
// do terminal, como índice em all. tabs: as folhas do .xlsx.
export function SheetPage({ all, jumpRecord, tabs, tab, onTab }: { all: string[][]; jumpRecord: number | null; tabs?: SheetTab[]; tab?: number; onTab?(index: number): void }): React.JSX.Element {
  const detected = useMemo(() => detectHeader(all), [all])
  const [headerChoice, setHeaderChoice] = useState<boolean | null>(null)
  const hasHeader = headerChoice ?? detected
  const header = hasHeader ? (all[0] ?? null) : null
  const body = useMemo(() => (hasHeader ? all.slice(1) : all), [all, hasHeader])
  const width = useMemo(() => all.reduce((max, row) => Math.max(max, row.length), 0), [all])
  const widths = useMemo(() => columnWidths(header, body, width), [header, body, width])
  const lefts = useMemo(() => widths.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? NUMBER_COLUMN) + w], [NUMBER_COLUMN]), [widths])
  const total = lefts[lefts.length - 1] ?? NUMBER_COLUMN
  const numeric = useMemo(() => widths.map((_, col) => columnKind(body.slice(0, SAMPLE).map((row) => row[col] ?? '')) === 'number'), [widths, body])
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const all_ = useMemo(() => body.map((_, i) => i), [body])
  const matches = useMemo(() => (deferred.trim() ? findMatches(body, all_, width, deferred) : null), [body, all_, width, deferred])
  const view = useMemo(() => (matches ? [...new Set(matches.map((m) => m.row))] : all_), [matches, all_])
  const hits = useMemo(() => new Set(matches?.map((m) => `${m.row}:${m.col}`)), [matches])
  const firstRow = hasHeader ? 2 : 1
  const scroller = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null)
  const [jumped, setJumped] = useState<number | null>(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setScroll({ top: element.scrollTop, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const jump = jumpRecord === null ? null : sheetJumpFor(jumpRecord, hasHeader)
  const jumpRow = jump?.kind === 'row' ? Math.min(jump.row, body.length - 1) : null
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || jumpRow === null || jumpRow < 0) return
    setQuery('')
    setJumped(jumpRow)
    element.scrollTop = Math.max(0, (jumpRow + 1) * ROW - element.clientHeight / 2)
    const timer = setTimeout(() => setJumped(null), 4000)
    return () => clearTimeout(timer)
  }, [jumpRow])

  const start = Math.max(0, Math.floor(scroll.top / ROW) - 1 - OVERSCAN)
  const end = Math.min(view.length, Math.ceil((scroll.top + scroll.height) / ROW) + OVERSCAN)
  const value = selected ? (body[selected.row]?.[selected.col] ?? '') : ''

  return <div className="sheet-page">
    <div className="sheet-toolbar">
      <label className="sheet-search"><Icon name="buscar" /><input aria-label="Buscar na planilha" placeholder="Buscar na planilha" value={query} enterKeyHint="search" autoComplete="off" onChange={(event) => setQuery(event.target.value)} /></label>
      <span className="sheet-count" role="status">{matches ? `${view.length.toLocaleString('pt-BR')} de ${body.length.toLocaleString('pt-BR')}` : `${body.length.toLocaleString('pt-BR')} ${body.length === 1 ? 'linha' : 'linhas'}`}</span>
      <label className="sheet-header-toggle"><input type="checkbox" checked={hasHeader} onChange={(event) => setHeaderChoice(event.target.checked)} />Cabeçalho</label>
    </div>
    <div className="sheet-scroller" ref={scroller} role="grid" aria-label="Planilha" aria-rowcount={view.length + 1} aria-colcount={width} onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <div className="sheet-canvas" style={{ width: total, height: (view.length + 1) * ROW }}>
        <div className="sheet-row sheet-head" role="row" style={{ width: total }}>
          <span className="sheet-num" role="columnheader" />
          {widths.map((w, col) => <span key={col} role="columnheader" className="sheet-cell" style={{ left: lefts[col], width: w }}>{header ? header[col] ?? '' : columnLabel(col)}</span>)}
        </div>
        {view.slice(start, end).map((index, offset) => {
          const at = start + offset
          const row = body[index] ?? []
          return <div key={index} role="row" className={`sheet-row ${jumped === index ? 'jumped' : ''}`} style={{ top: (at + 1) * ROW, width: total }}>
            <span className="sheet-num" role="rowheader">{index + firstRow}</span>
            {widths.map((w, col) => {
              const text = row[col] ?? ''
              const classes = ['sheet-cell', numeric[col] ? 'number' : '', hits.has(`${at}:${col}`) ? 'hit' : '', selected?.row === index && selected.col === col ? 'selected' : ''].filter(Boolean).join(' ')
              return <span key={col} role="gridcell" className={classes} style={{ left: lefts[col], width: w }} onClick={() => { setSelected({ row: index, col }); setCopied('') }}>{text}</span>
            })}
          </div>
        })}
      </div>
      {view.length === 0 && <p className="empty-copy sheet-empty">{matches ? 'Nada encontrado.' : 'Planilha vazia.'}</p>}
    </div>
    {selected && <div className="sheet-cell-bar">
      <strong>{columnLabel(selected.col)}{selected.row + firstRow}</strong>
      <span className="sheet-cell-value">{value || <em>vazia</em>}</span>
      {value && <button onClick={() => void copyText(value).then(() => setCopied('Copiado.'), (error: Error) => setCopied(error.message))}><Icon name="copiar" />{copied || 'Copiar'}</button>}
      <button className="icon-button" aria-label="Fechar célula" onClick={() => setSelected(null)}><Icon name="fechar" /></button>
    </div>}
    {tabs && tabs.length > 1 && <div className="sheet-tabs" role="tablist" aria-label="Folhas">
      {tabs.map((sheet, i) => <button key={`${i}:${sheet.name}`} role="tab" aria-selected={i === tab} className={sheet.hidden ? 'hidden-sheet' : ''} onClick={() => { setSelected(null); onTab?.(i) }}>{sheet.name}</button>)}
    </div>}
  </div>
}
