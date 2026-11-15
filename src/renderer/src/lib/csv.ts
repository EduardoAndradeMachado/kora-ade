import { isDateText, parseNumber, foldText } from './sheet-value'

export type Delimiter = ',' | ';' | '\t' | '|'

export const DELIMITERS: readonly { value: Delimiter; label: string }[] = [
  { value: ',', label: 'Vírgula' },
  { value: ';', label: 'Ponto e vírgula' },
  { value: '\t', label: 'Tabulação' },
  { value: '|', label: 'Barra vertical' }
]

const QUOTE = 0x22
const LF = 0x0a
const CR = 0x0d

// RFC 4180, tolerante como o Excel: aspas só abrem campo no começo dele; texto depois da aspa que fecha entra no
// campo; aspa sem par vai até o fim do arquivo. Fim de linha CRLF, LF ou CR. A quebra de linha final não cria
// registro vazio, mas linha em branco no meio continua sendo uma linha (vazia). starts, se vier, recebe a posição no
// texto onde cada registro começa (um registro com quebra de linha entre aspas ocupa várias linhas do arquivo).
export function parseCsv(text: string, delimiter: Delimiter, maxRecords = Infinity, starts?: number[]): string[][] {
  const rows: string[][] = []
  const d = delimiter.charCodeAt(0)
  const n = text.length
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  if (i >= n) return rows
  let row: string[] = []
  starts?.push(i)
  const fieldEnd = (from: number): number => {
    let k = from
    while (k < n) {
      const c = text.charCodeAt(k)
      if (c === d || c === LF || c === CR) break
      k++
    }
    return k
  }
  for (;;) {
    let value: string
    if (text.charCodeAt(i) === QUOTE) {
      value = ''
      let from = i + 1
      for (;;) {
        const q = text.indexOf('"', from)
        if (q < 0) {
          value += text.slice(from)
          i = n
          break
        }
        if (text.charCodeAt(q + 1) === QUOTE) {
          value += text.slice(from, q + 1)
          from = q + 2
          continue
        }
        value += text.slice(from, q)
        i = q + 1
        break
      }
      const end = fieldEnd(i)
      if (end > i) value += text.slice(i, end)
      i = end
    } else {
      const end = fieldEnd(i)
      value = text.slice(i, end)
      i = end
    }
    row.push(value)
    if (i >= n) {
      rows.push(row)
      break
    }
    const c = text.charCodeAt(i)
    if (c === d) {
      i++
      if (i >= n) {
        row.push('')
        rows.push(row)
        break
      }
      continue
    }
    i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1
    rows.push(row)
    row = []
    if (i >= n || rows.length >= maxRecords) break
    starts?.push(i)
  }
  return rows
}

const SAMPLE_CHARS = 64 * 1024
const SAMPLE_RECORDS = 50

// Olha várias linhas, não só a primeira: num CSV brasileiro (`;`) a vírgula decimal aparece em quase toda linha,
// mas não com a mesma contagem em todas. Ganha o separador que dá o mesmo número de campos (2 ou mais) no maior
// número de linhas; empate fica com o que dá mais colunas.
export function detectDelimiter(text: string, fallback: Delimiter = ','): Delimiter {
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text
  const truncated = sample.length < text.length
  let best: { delimiter: Delimiter; score: number; width: number } | null = null
  for (const { value: delimiter } of DELIMITERS) {
    const records = parseCsv(sample, delimiter, SAMPLE_RECORDS + 1)
    if (truncated && records.length > 1) records.pop()
    const counts = records.filter((r) => !(r.length === 1 && r[0] === '')).map((r) => r.length)
    if (counts.length === 0) continue
    const frequency = new Map<number, number>()
    for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1)
    let width = 0
    let hits = 0
    for (const [count, times] of frequency) {
      if (times > hits || (times === hits && count > width)) {
        width = count
        hits = times
      }
    }
    if (width < 2) continue
    const score = hits / counts.length
    if (!best || score > best.score || (score === best.score && width > best.width)) best = { delimiter, score, width }
  }
  return best?.delimiter ?? fallback
}

// Cabeçalho é a primeira linha só com rótulos: nenhum vazio, nenhum número ou data, nenhum repetido.
export function detectHeader(rows: readonly (readonly string[])[]): boolean {
  if (rows.length < 2) return false
  const first = rows[0]!
  if (first.length === 0) return false
  const seen = new Set<string>()
  for (const cell of first) {
    const label = cell.trim()
    if (label === '' || parseNumber(label) !== null || isDateText(label)) return false
    const key = foldText(label)
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

// Como o Excel copia: tab entre células, CRLF entre linhas; célula com tab, quebra de linha ou aspas vai entre
// aspas (com as aspas dobradas), senão colar no Excel quebraria a célula em várias.
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((cell) => (/[\t\r\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join('\t'))
    .join('\r\n')
}
