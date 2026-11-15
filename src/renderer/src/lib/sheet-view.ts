import { columnKind, decimalMarkOf, foldText, parseDate, parseNumber, type ColumnKind } from './sheet-value'

export type Rows = readonly (readonly string[])[]

export type SortDir = 'asc' | 'desc'
export interface SortSpec {
  col: number
  dir: SortDir
}

// excluded: valores desmarcados na lista (texto exato da célula, '' = vazias). Guardar o que saiu, e não o que
// ficou, deixa visível o valor novo que aparece quando o arquivo muda no disco, como no autofiltro do Excel.
export interface ColumnFilter {
  excluded?: ReadonlySet<string>
  contains?: string
}
export type Filters = ReadonlyMap<number, ColumnFilter>

export const cellAt = (rows: Rows, row: number, col: number): string => rows[row]?.[col] ?? ''

export const isFilterActive = (filter: ColumnFilter | undefined): boolean =>
  !!filter && ((filter.excluded?.size ?? 0) > 0 || (filter.contains ?? '').trim() !== '')

function matcher(filter: ColumnFilter): ((value: string) => boolean) | null {
  if (!isFilterActive(filter)) return null
  const excluded = filter.excluded && filter.excluded.size > 0 ? filter.excluded : null
  const needle = foldText((filter.contains ?? '').trim())
  return (value) => !(excluded?.has(value) ?? false) && (needle === '' || foldText(value).includes(needle))
}

// Índices (nas linhas de dados) do que passa em todos os filtros, na ordem do arquivo. `skip` deixa de fora o filtro
// de uma coluna: a lista de valores do autofiltro mostra o que os outros filtros deixam passar.
export function filterRows(rows: Rows, filters: Filters, skip?: number): number[] {
  const tests: [number, (value: string) => boolean][] = []
  for (const [col, filter] of filters) {
    if (col === skip) continue
    const test = matcher(filter)
    if (test) tests.push([col, test])
  }
  const out: number[] = []
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!
    let pass = true
    for (const [col, test] of tests) {
      if (!test(row[col] ?? '')) {
        pass = false
        break
      }
    }
    if (pass) out.push(r)
  }
  return out
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })
export const compareText = (a: string, b: string): number => collator.compare(a, b)

// Vazio vai para o fim nos dois sentidos, como no Excel; na coluna numérica (ou de datas), o que não é número
// (ou data) fica depois dos números e antes dos vazios. Empate mantém a ordem do arquivo.
export function sortRows(rows: Rows, indices: readonly number[], sort: SortSpec, kind?: ColumnKind): number[] {
  const { col, dir } = sort
  const column = indices.map((i) => cellAt(rows, i, col))
  const type = kind ?? columnKind(column)
  const sign = dir === 'asc' ? 1 : -1
  const mark = type === 'number' ? (decimalMarkOf(column) ?? undefined) : undefined
  const keyOf = type === 'number' ? (text: string) => parseNumber(text, mark) : type === 'date' ? parseDate : null
  const items = indices.map((index) => {
    const text = cellAt(rows, index, col)
    const empty = text.trim() === ''
    const key = empty || !keyOf ? null : keyOf(text)
    return { index, text, rank: empty ? 2 : keyOf && key === null ? 1 : 0, key }
  })
  items.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.rank === 2) return a.index - b.index
    const order = a.key !== null && b.key !== null ? a.key - b.key : compareText(a.text, b.text)
    return order === 0 ? a.index - b.index : sign * order
  })
  return items.map((item) => item.index)
}

export function viewRows(rows: Rows, filters: Filters, sort: SortSpec | null): number[] {
  const kept = filterRows(rows, filters)
  return sort ? sortRows(rows, kept, sort) : kept
}

export interface DistinctValue {
  value: string
  count: number
}

// Lista do autofiltro: cada valor diferente com quantas linhas têm ele, na ordem da coluna (números como número,
// datas como data); o vazio por último.
export function distinctValues(rows: Rows, indices: readonly number[], col: number): DistinctValue[] {
  const counts = new Map<string, number>()
  for (const i of indices) {
    const value = cellAt(rows, i, col)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const values = [...counts.keys()]
  const kind = columnKind(values)
  const fake = values.map((v) => [v])
  const order = sortRows(fake, fake.map((_, i) => i), { col: 0, dir: 'asc' }, kind)
  return order.map((i) => ({ value: values[i]!, count: counts.get(values[i]!)! }))
}

export interface Match {
  row: number
  col: number
}

// Tirar acento de milhões de células leva quase um segundo: fica guardado enquanto as linhas forem as mesmas, e a
// próxima busca (cada tecla digitada) só compara.
const foldedCache = new WeakMap<Rows, string[][]>()
function foldedRows(rows: Rows): string[][] {
  let folded = foldedCache.get(rows)
  if (!folded) {
    folded = rows.map((row) => row.map(foldText))
    foldedCache.set(rows, folded)
  }
  return folded
}

// Ocorrências na ordem de leitura (linha a linha) das linhas visíveis. `row` é a posição na vista, não no arquivo.
export function findMatches(rows: Rows, view: readonly number[], width: number, query: string, limit = 100_000): Match[] {
  const needle = foldText(query.trim())
  const out: Match[] = []
  if (needle === '') return out
  const folded = foldedRows(rows)
  for (let v = 0; v < view.length && out.length < limit; v++) {
    const row = folded[view[v]!]
    if (!row) continue
    const end = Math.min(width, row.length)
    for (let c = 0; c < end; c++) {
      if (row[c]!.includes(needle)) {
        out.push({ row: v, col: c })
        if (out.length >= limit) break
      }
    }
  }
  return out
}
