import { toTsv } from './csv'
import { decimalMarkOf, parseNumber, type DecimalMark } from './sheet-value'
import { cellAt, type Rows } from './sheet-view'

// Posições na vista (linha depois de filtrar e ordenar, coluna).
export interface CellPos {
  row: number
  col: number
}

export interface Selection {
  anchor: CellPos
  focus: CellPos
}

export interface CellRange {
  top: number
  left: number
  bottom: number
  right: number
}

export const rangeOf = ({ anchor, focus }: Selection): CellRange => ({
  top: Math.min(anchor.row, focus.row),
  left: Math.min(anchor.col, focus.col),
  bottom: Math.max(anchor.row, focus.row),
  right: Math.max(anchor.col, focus.col)
})

export const inRange = (range: CellRange, row: number, col: number): boolean =>
  row >= range.top && row <= range.bottom && col >= range.left && col <= range.right

// 0 → A, 25 → Z, 26 → AA, como as colunas do Excel.
export function columnLabel(col: number): string {
  let n = col + 1
  let label = ''
  while (n > 0) {
    const rest = (n - 1) % 26
    label = String.fromCharCode(65 + rest) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

export interface SelectionStats {
  // Células não vazias, como a "Contagem" da barra do Excel.
  count: number
  numbers: number
  sum: number
}

// O decimal da coluna sai da coluna inteira (na vista), não só do que está selecionado: selecionar só "1.000"
// não diz se é mil ou um.
function* columnValues(rows: Rows, view: readonly number[], col: number): Generator<string> {
  for (const index of view) yield cellAt(rows, index, col)
}

// Guardado por vista: a soma de uma seleção grande é feita aos pedaços, e cada pedaço olharia a coluna de novo.
const markCache = new WeakMap<Rows, WeakMap<readonly number[], Map<number, DecimalMark | undefined>>>()
function marksFor(rows: Rows, view: readonly number[]): Map<number, DecimalMark | undefined> {
  let byView = markCache.get(rows)
  if (!byView) markCache.set(rows, (byView = new WeakMap()))
  let marks = byView.get(view)
  if (!marks) byView.set(view, (marks = new Map()))
  return marks
}

export function selectionStats(rows: Rows, view: readonly number[], range: CellRange): SelectionStats {
  let count = 0
  let numbers = 0
  let sum = 0
  const bottom = Math.min(range.bottom, view.length - 1)
  const marks = marksFor(rows, view)
  const markOf = (col: number): DecimalMark | undefined => {
    if (!marks.has(col)) marks.set(col, decimalMarkOf(columnValues(rows, view, col)) ?? undefined)
    return marks.get(col)
  }
  for (let v = range.top; v <= bottom; v++) {
    const row = rows[view[v]!]
    if (!row) continue
    const right = Math.min(range.right, row.length - 1)
    for (let c = range.left; c <= right; c++) {
      const cell = row[c]!
      if (cell === '' || cell.trim() === '') continue
      count++
      const value = parseNumber(cell, markOf(c))
      if (value !== null) {
        numbers++
        sum += value
      }
    }
  }
  return { count, numbers, sum }
}

// O intervalo selecionado, nas linhas da vista (filtradas e na ordem da tela, como o Excel copia um intervalo
// filtrado). Selecionando colunas inteiras, o cabeçalho vai junto na primeira linha.
export function selectionTsv(rows: Rows, view: readonly number[], range: CellRange, header: readonly string[] | null): string {
  const out: string[][] = []
  const width = range.right - range.left + 1
  const wholeColumns = range.top === 0 && range.bottom >= view.length - 1
  if (header && wholeColumns) out.push(Array.from({ length: width }, (_, i) => header[range.left + i] ?? ''))
  const bottom = Math.min(range.bottom, view.length - 1)
  for (let v = range.top; v <= bottom; v++) {
    out.push(Array.from({ length: width }, (_, i) => cellAt(rows, view[v]!, range.left + i)))
  }
  return toTsv(out)
}
