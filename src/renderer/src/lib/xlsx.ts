// Leitor de .xlsx só para mostrar valores: zip lido à mão e descompactado pelo DecompressionStream nativo, XML
// varrido por um laço linear (sem regex com retrocesso, sem DTD, sem entidades além das cinco do XML). O arquivo é
// entrada não confiável: cada parte descompactada tem teto de bytes conferido durante a descompactação, não pelo
// tamanho que o próprio zip declara.

import { OPEN_LIMITS } from '../../../shared/open-limits'

export type XlsxErrorKind = 'protected' | 'corrupt' | 'too-large'

export class XlsxError extends Error {
  constructor(
    readonly kind: XlsxErrorKind,
    message: string
  ) {
    super(message)
  }
}

export interface XlsxLimits {
  // Teto de cada parte descompactada e da soma de todas as que forem lidas.
  partBytes: number
  totalBytes: number
}

// Medido em shared/open-limits: 256 MB de XML já custam ~650 MB na janela.
export const XLSX_LIMITS: XlsxLimits = { partBytes: OPEN_LIMITS.xlsxPartBytes, totalBytes: OPEN_LIMITS.xlsxTotalBytes }

const MAX_ROWS = 1_048_576
const MAX_COLS = 16_384

// ---------------------------------------------------------------- zip

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  localOffset: number
}

const corrupt = (detail: string): XlsxError => new XlsxError('corrupt', `Planilha corrompida ou não é um .xlsx (${detail}).`)

function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Office protegido por senha não é zip: é um contêiner OLE (o mesmo do .xls antigo) com o pacote cifrado dentro.
  if (bytes.length >= 8 && view.getUint32(0, false) === 0xd0cf11e0 && view.getUint32(4, false) === 0xa1b11ae1) {
    throw new XlsxError('protected', 'Planilha protegida por senha (ou no formato antigo do Excel): não dá para ler aqui.')
  }
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw corrupt('fim do zip não encontrado')
  const count = view.getUint16(eocd + 10, true)
  const dirOffset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || dirOffset === 0xffffffff) throw corrupt('zip64 não suportado')
  const entries = new Map<string, ZipEntry>()
  const names = new TextDecoder()
  let at = dirOffset
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw corrupt('diretório do zip inválido')
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    if (at + 46 + nameLength > bytes.length) throw corrupt('diretório do zip inválido')
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    entries.set(name.toLowerCase(), {
      name,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      localOffset: view.getUint32(at + 42, true)
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function inflateRaw(data: Uint8Array, cap: number): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        void reader.cancel().catch(() => {})
        throw new XlsxError('too-large', `Planilha grande demais para abrir aqui (mais de ${Math.round(cap / 1024 / 1024)} MB descompactados).`)
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof XlsxError) throw err
    throw corrupt('dados compactados inválidos')
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

class ZipReader {
  private used = 0
  private readonly entries: Map<string, ZipEntry>

  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: XlsxLimits
  ) {
    this.entries = zipEntries(bytes)
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase())
  }

  async text(name: string): Promise<string | null> {
    const entry = this.entries.get(name.toLowerCase())
    if (!entry) return null
    if (entry.flags & 1) throw new XlsxError('protected', 'Planilha com conteúdo criptografado: não dá para ler aqui.')
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
    const at = entry.localOffset
    if (at + 30 > this.bytes.length || view.getUint32(at, true) !== 0x04034b50) throw corrupt(`parte ${entry.name}`)
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
    const end = start + entry.compressedSize
    if (end > this.bytes.length) throw corrupt(`parte ${entry.name} cortada`)
    const data = this.bytes.subarray(start, end)
    const cap = Math.min(this.limits.partBytes, this.limits.totalBytes - this.used)
    let raw: Uint8Array
    if (entry.method === 0) {
      if (data.byteLength > cap) throw new XlsxError('too-large', 'Planilha grande demais para abrir aqui.')
      raw = data
    } else if (entry.method === 8) {
      raw = await inflateRaw(data, cap)
    } else {
      throw corrupt(`compressão ${entry.method} não suportada`)
    }
    this.used += raw.byteLength
    return new TextDecoder().decode(raw)
  }
}

// ---------------------------------------------------------------- xml

interface XmlHandler {
  open(name: string, xml: string, attrStart: number, attrEnd: number): void
  close?(name: string): void
  // Texto cru (com entidades) entre start e end.
  text?(xml: string, start: number, end: number): void
}

const localName = (qualified: string): string => {
  const colon = qualified.indexOf(':')
  return colon < 0 ? qualified : qualified.slice(colon + 1)
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
}

function scanXml(xml: string, handler: XmlHandler): void {
  const n = xml.length
  let i = 0
  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      handler.text?.(xml, i, n)
      return
    }
    if (lt > i) handler.text?.(xml, i, lt)
    const next = xml.charCodeAt(lt + 1)
    if (next === 0x21) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4)
        i = end < 0 ? n : end + 3
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9)
        handler.text?.(xml, lt + 9, end < 0 ? n : end)
        i = end < 0 ? n : end + 3
      } else {
        // DOCTYPE e afins: ignorados, sem expandir nada que venha neles.
        const end = xml.indexOf('>', lt)
        i = end < 0 ? n : end + 1
      }
      continue
    }
    if (next === 0x3f) {
      const end = xml.indexOf('?>', lt)
      i = end < 0 ? n : end + 2
      continue
    }
    let gt = lt + 1
    let quote = 0
    while (gt < n) {
      const c = xml.charCodeAt(gt)
      if (quote) {
        if (c === quote) quote = 0
      } else if (c === 0x22 || c === 0x27) quote = c
      else if (c === 0x3e) break
      gt++
    }
    if (gt >= n) throw corrupt('XML cortado')
    if (next === 0x2f) {
      handler.close?.(localName(xml.slice(lt + 2, gt).trim()))
      i = gt + 1
      continue
    }
    const selfClosing = xml.charCodeAt(gt - 1) === 0x2f
    let nameEnd = lt + 1
    while (nameEnd < gt) {
      const c = xml.charCodeAt(nameEnd)
      if (isSpace(c) || c === 0x2f) break
      nameEnd++
    }
    const name = localName(xml.slice(lt + 1, nameEnd))
    handler.open(name, xml, nameEnd, selfClosing ? gt - 1 : gt)
    if (selfClosing) handler.close?.(name)
    i = gt + 1
  }
}

// Valor do atributo pelo nome local (o prefixo do namespace muda de um gerador para outro), ou null.
function attr(xml: string, start: number, end: number, wanted: string): string | null {
  let i = start
  while (i < end) {
    while (i < end && isSpace(xml.charCodeAt(i))) i++
    const nameStart = i
    while (i < end && xml.charCodeAt(i) !== 0x3d && !isSpace(xml.charCodeAt(i))) i++
    const name = xml.slice(nameStart, i)
    while (i < end && isSpace(xml.charCodeAt(i))) i++
    if (xml.charCodeAt(i) !== 0x3d) return null
    i++
    while (i < end && isSpace(xml.charCodeAt(i))) i++
    const quote = xml.charCodeAt(i)
    if (quote !== 0x22 && quote !== 0x27) return null
    const valueEnd = xml.indexOf(String.fromCharCode(quote), i + 1)
    if (valueEnd < 0 || valueEnd > end) return null
    if (localName(name) === wanted) return decodeEntities(xml.slice(i + 1, valueEnd))
    i = valueEnd + 1
  }
  return null
}

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(ENTITY, (_, body: string) =>
    body[0] === '#' ? codePoint(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)) : NAMED[body]!
  )
}

// O Excel guarda caractere de controle como _xHHHH_ (o _x000D_ do CR); um "_x" do próprio texto vem como _x005F_x.
const ESCAPED = /_x([0-9a-fA-F]{4})_/g
const unescapeOoxml = (text: string): string => (text.includes('_x') ? text.replace(ESCAPED, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : text)

// ---------------------------------------------------------------- pacote

function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

const relsOf = (part: string): string => {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

interface Relationship {
  id: string
  type: string
  target: string
}

function parseRels(xml: string): Relationship[] {
  const out: Relationship[] = []
  scanXml(xml, {
    open(name, src, s, e) {
      if (name !== 'Relationship') return
      if (attr(src, s, e, 'TargetMode') === 'External') return
      out.push({ id: attr(src, s, e, 'Id') ?? '', type: attr(src, s, e, 'Type') ?? '', target: attr(src, s, e, 'Target') ?? '' })
    }
  })
  return out
}

// Igual no OOXML de transição e no estrito: os dois tipos terminam com o mesmo nome.
const typeIs = (rel: Relationship, kind: string): boolean => rel.type.endsWith(`/${kind}`)

function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  let current: string[] | null = null
  let inText = false
  let phonetic = 0
  scanXml(xml, {
    open(name) {
      if (name === 'si') current = []
      else if (name === 'rPh') phonetic++
      else if (name === 't' && current && phonetic === 0) inText = true
    },
    close(name) {
      if (name === 'si') {
        out.push(unescapeOoxml((current ?? []).join('')))
        current = null
      } else if (name === 'rPh') phonetic--
      else if (name === 't') inText = false
    },
    text(src, start, end) {
      if (inText && current) current.push(decodeEntities(src.slice(start, end)))
    }
  })
  return out
}

export type NumberStyle =
  | { kind: 'general' }
  | { kind: 'fixed'; decimals: number }
  | { kind: 'percent'; decimals: number }
  | { kind: 'date'; date: boolean; time: boolean; seconds: boolean }

const BUILTIN_DATES: Record<number, NumberStyle> = {
  14: { kind: 'date', date: true, time: false, seconds: false },
  15: { kind: 'date', date: true, time: false, seconds: false },
  16: { kind: 'date', date: true, time: false, seconds: false },
  17: { kind: 'date', date: true, time: false, seconds: false },
  18: { kind: 'date', date: false, time: true, seconds: false },
  19: { kind: 'date', date: false, time: true, seconds: true },
  20: { kind: 'date', date: false, time: true, seconds: false },
  21: { kind: 'date', date: false, time: true, seconds: true },
  22: { kind: 'date', date: true, time: true, seconds: false },
  45: { kind: 'date', date: false, time: true, seconds: true },
  46: { kind: 'date', date: false, time: true, seconds: true },
  47: { kind: 'date', date: false, time: true, seconds: true }
}
const BUILTIN_NUMBERS: Record<number, NumberStyle> = {
  1: { kind: 'fixed', decimals: 0 },
  2: { kind: 'fixed', decimals: 2 },
  3: { kind: 'fixed', decimals: 0 },
  4: { kind: 'fixed', decimals: 2 },
  9: { kind: 'percent', decimals: 0 },
  10: { kind: 'percent', decimals: 2 }
}

// Só o que é simples: data/hora, % e casas decimais fixas. O resto mostra o número como o "Geral" do Excel.
export function numberStyle(id: number, code: string | undefined): NumberStyle {
  if (code === undefined) {
    if (BUILTIN_DATES[id]) return BUILTIN_DATES[id]
    // 27–36 e 50–58: datas dos formatos de idioma asiático.
    if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return { kind: 'date', date: true, time: false, seconds: false }
    return BUILTIN_NUMBERS[id] ?? { kind: 'general' }
  }
  // Só a primeira seção (a dos positivos); fora texto entre aspas, caractere escapado e [cor]/[$-416].
  const section = code.split(';')[0] ?? ''
  const plain = section.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '')
  if (/general/i.test(plain)) return { kind: 'general' }
  const lower = plain.toLowerCase()
  const date = /[dy]/.test(lower) || (/m/.test(lower) && !/[hs]/.test(lower))
  const time = /[hs]/.test(lower)
  if (date || time) return { kind: 'date', date, time, seconds: /s/.test(lower) }
  const decimals = /\.([0#?]+)/.exec(plain)?.[1]?.length ?? 0
  if (plain.includes('%')) return { kind: 'percent', decimals }
  if (/[0#?]/.test(plain)) return { kind: 'fixed', decimals }
  return { kind: 'general' }
}

function parseStyles(xml: string): NumberStyle[] {
  const codes = new Map<number, string>()
  const xfIds: number[] = []
  let inCellXfs = false
  scanXml(xml, {
    open(name, src, s, e) {
      if (name === 'numFmt') {
        const id = Number(attr(src, s, e, 'numFmtId'))
        const code = attr(src, s, e, 'formatCode')
        if (Number.isInteger(id) && code !== null) codes.set(id, code)
      } else if (name === 'cellXfs') inCellXfs = true
      else if (name === 'xf' && inCellXfs) xfIds.push(Number(attr(src, s, e, 'numFmtId') ?? 0) || 0)
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false
    }
  })
  return xfIds.map((id) => numberStyle(id, codes.get(id)))
}

const pad = (n: number): string => String(n).padStart(2, '0')

// Série do Excel para data. No sistema 1900 o Excel conta um 29/02/1900 que não existiu (série 60): depois dele,
// o dia zero é 30/12/1899.
export function serialToDate(serial: number, date1904: boolean): Date {
  const base = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)
  return new Date(base + Math.round(serial * 86_400) * 1000)
}

export function formatSerial(serial: number, style: Extract<NumberStyle, { kind: 'date' }>, date1904: boolean): string {
  const d = serialToDate(serial, date1904)
  const datePart = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
  const timePart = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${style.seconds ? `:${pad(d.getUTCSeconds())}` : ''}`
  if (style.date && style.time) return `${datePart} ${timePart}`
  if (style.time) return timePart
  return datePart
}

function formatGeneral(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const abs = Math.abs(value)
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return value.toExponential(9).replace(/\.?0+e/, 'e').replace('.', ',').toUpperCase()
  // 15 algarismos significativos: 0,1 + 0,2 gravado como 0.30000000000000004 aparece 0,3, como no Excel.
  return String(Number(value.toPrecision(15))).replace('.', ',')
}

export function formatCellNumber(value: number, style: NumberStyle, date1904: boolean): string {
  switch (style.kind) {
    case 'date':
      return value >= 0 && value < 2_958_466 ? formatSerial(value, style, date1904) : formatGeneral(value)
    case 'percent':
      return `${(value * 100).toFixed(style.decimals).replace('.', ',')}%`
    case 'fixed':
      return value.toFixed(style.decimals).replace('.', ',')
    default:
      return formatGeneral(value)
  }
}

function columnIndex(ref: string): number {
  let col = 0
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i)
    if (c >= 65 && c <= 90) col = col * 26 + (c - 64)
    else if (c >= 97 && c <= 122) col = col * 26 + (c - 96)
    else break
  }
  return col - 1
}

function isoDateText(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value)
  if (!m) return value
  const date = `${m[3]}/${m[2]}/${m[1]}`
  return m[4] && `${m[4]}${m[5]}${m[6] ?? ''}` !== '000000' ? `${date} ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''}` : date
}

interface SheetContext {
  shared: readonly string[]
  styles: readonly NumberStyle[]
  date1904: boolean
}

export function parseWorksheet(xml: string, ctx: SheetContext): string[][] {
  const rows: string[][] = []
  let rowIndex = -1
  let col = -1
  let cell: { type: string; style: number; value: string[]; inline: string[] } | null = null
  let collect: 'v' | 'is' | null = null
  let phonetic = 0
  let inData = false
  scanXml(xml, {
    open(name, src, s, e) {
      if (name === 'sheetData') inData = true
      if (!inData) return
      if (name === 'row') {
        const r = Number(attr(src, s, e, 'r'))
        rowIndex = Number.isInteger(r) && r >= 1 ? r - 1 : rowIndex + 1
        if (rowIndex >= MAX_ROWS) throw corrupt('linha fora do limite do Excel')
        col = -1
      } else if (name === 'c') {
        const ref = attr(src, s, e, 'r')
        const at = ref ? columnIndex(ref) : -1
        col = at >= 0 ? at : col + 1
        if (col >= MAX_COLS) throw corrupt('coluna fora do limite do Excel')
        cell = { type: attr(src, s, e, 't') ?? 'n', style: Number(attr(src, s, e, 's') ?? 0) || 0, value: [], inline: [] }
      } else if (cell && name === 'v') collect = 'v'
      else if (cell && name === 'rPh') phonetic++
      else if (cell && name === 't' && phonetic === 0) collect = 'is'
    },
    close(name) {
      if (name === 'sheetData') inData = false
      else if (name === 'v' || name === 't') collect = null
      else if (name === 'rPh') phonetic--
      else if (name === 'c' && cell) {
        const display = cellText(cell.type, cell.value.join(''), cell.inline.join(''), cell.style, ctx)
        if (display !== '' && rowIndex >= 0) (rows[rowIndex] ??= [])[col] = display
        cell = null
      }
    },
    text(src, start, end) {
      if (!collect || !cell) return
      const piece = decodeEntities(src.slice(start, end))
      if (collect === 'v') cell.value.push(piece)
      else cell.inline.push(piece)
    }
  })
  for (let r = 0; r < rows.length; r++) {
    const row = (rows[r] ??= [])
    for (let c = 0; c < row.length; c++) row[c] ??= ''
  }
  return rows
}

function cellText(type: string, value: string, inline: string, style: number, ctx: SheetContext): string {
  switch (type) {
    case 's': {
      const index = Number(value)
      return Number.isInteger(index) ? (ctx.shared[index] ?? '') : ''
    }
    case 'inlineStr':
      return unescapeOoxml(inline)
    case 'str':
      return unescapeOoxml(value)
    case 'e':
      return value
    case 'b':
      return value === '' ? '' : value === '1' || value === 'true' ? 'VERDADEIRO' : 'FALSO'
    case 'd':
      return isoDateText(value)
    default: {
      if (value.trim() === '') return ''
      const number = Number(value)
      if (!Number.isFinite(number)) return value
      return formatCellNumber(number, ctx.styles[style] ?? { kind: 'general' }, ctx.date1904)
    }
  }
}

// ---------------------------------------------------------------- pasta de trabalho

export interface XlsxSheet {
  name: string
  hidden: boolean
}

export interface XlsxBook {
  sheets: XlsxSheet[]
  readSheet(index: number): Promise<string[][]>
}

export async function openXlsx(bytes: Uint8Array, limits: XlsxLimits = XLSX_LIMITS): Promise<XlsxBook> {
  const zip = new ZipReader(bytes, limits)
  const rootRels = parseRels((await zip.text('_rels/.rels')) ?? '')
  const workbookPath = resolvePart('', rootRels.find((r) => typeIs(r, 'officeDocument'))?.target ?? 'xl/workbook.xml')
  const workbookXml = await zip.text(workbookPath)
  if (workbookXml === null) {
    if (zip.has('EncryptionInfo')) throw new XlsxError('protected', 'Planilha protegida por senha: não dá para ler aqui.')
    throw corrupt('sem xl/workbook.xml')
  }
  const rels = parseRels((await zip.text(relsOf(workbookPath))) ?? '')
  const byId = new Map(rels.map((r) => [r.id, r]))

  const listed: { name: string; hidden: boolean; path: string | null }[] = []
  let date1904 = false
  scanXml(workbookXml, {
    open(name, src, s, e) {
      if (name === 'workbookPr') {
        const flag = attr(src, s, e, 'date1904')
        date1904 = flag === '1' || flag === 'true'
      } else if (name === 'sheet') {
        const rel = byId.get(attr(src, s, e, 'id') ?? '')
        const state = attr(src, s, e, 'state')
        listed.push({
          name: attr(src, s, e, 'name') ?? `Planilha${listed.length + 1}`,
          hidden: state === 'hidden' || state === 'veryHidden',
          // Folha de gráfico (chartsheet) não tem células.
          path: rel && typeIs(rel, 'worksheet') ? resolvePart(workbookPath, rel.target) : null
        })
      }
    }
  })
  const sheets = listed.filter((s): s is { name: string; hidden: boolean; path: string } => s.path !== null)
  if (sheets.length === 0) throw corrupt('nenhuma folha com células')

  const sharedRel = rels.find((r) => typeIs(r, 'sharedStrings'))
  const stylesRel = rels.find((r) => typeIs(r, 'styles'))
  const sharedXml = sharedRel ? await zip.text(resolvePart(workbookPath, sharedRel.target)) : null
  const stylesXml = stylesRel ? await zip.text(resolvePart(workbookPath, stylesRel.target)) : null
  const ctx: SheetContext = {
    shared: sharedXml ? parseSharedStrings(sharedXml) : [],
    styles: stylesXml ? parseStyles(stylesXml) : [],
    date1904
  }
  const cache = new Map<number, Promise<string[][]>>()

  return {
    sheets: sheets.map(({ name, hidden }) => ({ name, hidden })),
    readSheet(index) {
      const sheet = sheets[index]
      if (!sheet) return Promise.reject(new Error(`Folha ${index} não existe`))
      let rows = cache.get(index)
      if (!rows) {
        rows = zip.text(sheet.path).then((xml) => {
          if (xml === null) throw corrupt(`folha ${sheet.name} ausente`)
          return parseWorksheet(xml, ctx)
        })
        cache.set(index, rows)
        rows.catch(() => cache.delete(index))
      }
      return rows
    }
  }
}
