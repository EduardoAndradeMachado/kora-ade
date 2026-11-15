// Leitura dos valores de célula como o Excel em pt-BR enxerga: número com vírgula ou ponto decimal, moeda, %,
// data ISO ou dd/mm/aaaa. Tudo a partir do texto, igual para CSV e xlsx.

const ASCII = /^\p{ASCII}*$/u
const MARKS = /\p{M}/gu

// Sem acento e sem maiúscula: "JOÃO" e "joao" são o mesmo texto na busca, no filtro e na ordenação.
export function foldText(text: string): string {
  return ASCII.test(text) ? text.toLowerCase() : text.normalize('NFD').replace(MARKS, '').toLowerCase()
}

// Uma passada só, antes das regex: descarta de cara o texto, a data e a hora (a maioria das células), que somar ou
// selecionar milhões de células faria passar pelas regex uma a uma. Um "-" só: dois é data ISO.
function couldBeNumber(raw: string): boolean {
  let digits = 0
  let minus = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c >= 0x30 && c <= 0x39) digits++
    else if (c === 0x2d || c === 0x2212) {
      if (++minus > 1) return false
    } else if (!NUMBER_CHARS.has(c)) return false
  }
  return digits > 0
}
const NUMBER_CHARS = new Set([...' \t.,%+()R$US€£eE\u00a0\u202f'].map((ch) => ch.charCodeAt(0)))
const PLAIN_INTEGER = /^-?\d{1,15}$/
const SIMPLE_DECIMAL = /^-?\d{1,15}([.,])\d{1,15}$/
const CURRENCY = /^(?:R\$|US\$|\$|€|£)\s*/
const SPACES = /[\s\u00a0\u202f]/g
const EXPONENT = /^(?:\d+(?:[.,]\d*)?|[.,]\d+)e[+-]?\d+$/i
const DIGITS = /^[\d.,]+$/

export type DecimalMark = ',' | '.'

// Com ponto e vírgula juntos, o último é o decimal (1.234,56 e 1,234.56). Um só tipo de separador: repetido é
// milhar (1.234.567), uma vez só é decimal (1234,56 e 3.14). "1.000" sozinho não diz se é mil ou um: quem sabe é
// a coluna (`decimal`, de decimalMarkOf), e aí o separador que não é o decimal da coluna vale como milhar.
export function parseNumber(raw: string, decimal?: DecimalMark): number | null {
  if (raw.length === 0 || raw.length > 64 || !couldBeNumber(raw)) return null
  if (PLAIN_INTEGER.test(raw)) return Number(raw)
  const simple = SIMPLE_DECIMAL.exec(raw)
  if (simple && (decimal === undefined || decimal === simple[1])) return Number(raw.replace(',', '.'))
  let s = raw.trim()
  if (s === '') return null
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1).trim()
  }
  // O sinal vem antes ou depois da moeda: "-R$ 10" e "R$ -10".
  const takeSign = (): void => {
    const sign = s[0]
    if (sign === '-' || sign === '+' || sign === '\u2212') {
      if (sign !== '+') negative = !negative
      s = s.slice(1).trimStart()
    }
  }
  takeSign()
  const before = s.length
  s = s.replace(CURRENCY, '')
  if (s.length !== before) takeSign()
  let percent = false
  if (s.endsWith('%')) {
    percent = true
    s = s.slice(0, -1).trimEnd()
  }
  s = s.replace(SPACES, '')
  if (s === '') return null
  let value: number
  if (EXPONENT.test(s)) value = Number(s.replace(',', '.'))
  else if (!DIGITS.test(s)) return null
  else {
    const parsed = separatedNumber(s, decimal)
    if (parsed === null) return null
    value = parsed
  }
  if (!Number.isFinite(value)) return null
  if (percent) value /= 100
  return negative ? -value : value
}

function separatedNumber(s: string, hint: DecimalMark | undefined): number | null {
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  let decimal: string | null = null
  let group: string | null = null
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? '.' : ','
    group = decimal === '.' ? ',' : '.'
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ','
    if (s.indexOf(sep) === s.lastIndexOf(sep) && (hint === undefined || hint === sep)) decimal = sep
    else group = sep
  }
  let int = s
  let frac = ''
  if (decimal !== null) {
    const at = s.lastIndexOf(decimal)
    if (s.indexOf(decimal) !== at) return null
    int = s.slice(0, at)
    frac = s.slice(at + 1)
    if (frac.includes('.') || frac.includes(',')) return null
  }
  if (group !== null) {
    const groups = int.split(group)
    if (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null
    int = groups.join('')
  }
  if (int === '' && frac === '') return null
  return Number(`${int || '0'}.${frac || '0'}`)
}

const NUMERIC_CORE = /\d[\d.,]*/

// O decimal que a coluna usa, pelos valores que não deixam dúvida: com os dois separadores, o último; com um
// só, aparecendo uma vez e sem exatamente 3 algarismos depois ("12,5", "3.14"). Null quando nada decide.
export function decimalMarkOf(values: Iterable<string>, sample = 2000): DecimalMark | null {
  let comma = 0
  let dot = 0
  let seen = 0
  for (const value of values) {
    const core = NUMERIC_CORE.exec(value)?.[0]
    if (!core) continue
    if (++seen > sample) break
    const lastDot = core.lastIndexOf('.')
    const lastComma = core.lastIndexOf(',')
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastComma > lastDot) comma++
      else dot++
    } else if (lastDot >= 0 || lastComma >= 0) {
      const at = Math.max(lastDot, lastComma)
      const sep = core[at]
      if (core.indexOf(sep!) === at && core.length - at - 1 !== 3) {
        if (sep === ',') comma++
        else dot++
      } else if (core.indexOf(sep!) !== at) {
        // Repetido é milhar: o decimal é o outro.
        if (sep === ',') dot++
        else comma++
      }
    }
  }
  if (comma === dot) return null
  return comma > dot ? ',' : '.'
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const BR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/

function utc(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  // 31/02 vira 03/03 no Date.UTC: não é data.
  return new Date(ms).getUTCDate() === d ? ms : null
}

// Instante para ordenar (ms). Sem fuso, a hora vale como está escrita; com fuso, o instante de verdade.
export function parseDate(raw: string): number | null {
  const s = raw.trim()
  if (s.length < 8 || s.length > 40) return null
  let m = ISO.exec(s)
  if (m) {
    const at = utc(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
    if (at === null || !m[7]) return at
    const parsed = Date.parse(s.replace(' ', 'T'))
    return Number.isNaN(parsed) ? at : parsed
  }
  m = BR.exec(s)
  if (m) return utc(+m[3]!, +m[2]!, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
  return null
}

export const isDateText = (raw: string): boolean => parseDate(raw) !== null

export type ColumnKind = 'number' | 'date' | 'text'

// A coluna é numérica (ou de datas) quando quase tudo que não está vazio é número (ou data): uma célula "n/d" no
// meio não transforma a coluna inteira em texto.
export function columnKind(values: Iterable<string>, sample = 2000): ColumnKind {
  let filled = 0
  let numbers = 0
  let dates = 0
  for (const value of values) {
    if (value.trim() === '') continue
    filled++
    if (parseNumber(value) !== null) numbers++
    else if (parseDate(value) !== null) dates++
    if (filled >= sample) break
  }
  if (filled === 0) return 'text'
  if (numbers / filled >= 0.8) return 'number'
  if (dates / filled >= 0.8) return 'date'
  return 'text'
}

export function formatNumber(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 10 })
}
