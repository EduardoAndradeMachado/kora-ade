import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { editorLanguageFor, markdownPreviewDecision, OPEN_LIMITS } from '../src/shared/open-limits'
import { openXlsx, XlsxError } from '../src/renderer/src/lib/xlsx'
import { readSheetBytes } from '../src/main/xlsx'
import { readText } from '../src/main/files'

const MB = 1024 * 1024

describe('editorLanguageFor', () => {
  it('TS e JS acima de 1 MB perdem o worker e ficam só com o realce', () => {
    expect(editorLanguageFor('typescript', 1 * MB)).toBe('typescript')
    expect(editorLanguageFor('typescript', 1 * MB + 1)).toBe('typescript-leve')
    expect(editorLanguageFor('javascript', 1 * MB + 1)).toBe('javascript-leve')
  })

  it('JSON, CSS e HTML têm teto de 5 MB', () => {
    expect(editorLanguageFor('json', 2 * MB)).toBe('json')
    expect(editorLanguageFor('json', 5 * MB + 1)).toBe('json-leve')
    expect(editorLanguageFor('html', 5 * MB + 1)).toBe('html-leve')
  })

  it('linguagem sem worker não muda, de qualquer tamanho', () => {
    expect(editorLanguageFor('python', 40 * MB)).toBe('python')
    expect(editorLanguageFor(undefined, 40 * MB)).toBeUndefined()
  })
})

describe('markdownPreviewDecision', () => {
  it('desenha até 1 MB, pergunta até 2 MB e acima disso só deixa editar', () => {
    expect(markdownPreviewDecision(1 * MB, false)).toBe('render')
    expect(markdownPreviewDecision(1 * MB + 1, false)).toBe('ask')
    expect(markdownPreviewDecision(1 * MB + 1, true)).toBe('render')
    expect(markdownPreviewDecision(2 * MB + 1, true)).toBe('edit-only')
  })
})

describe('leitura no main com a tabela', () => {
  let root = ''
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('texto e planilha: acima do limite pedem "mesmo assim"; acima do teto, só o programa padrão', () => {
    root = mkdtempSync(join(tmpdir(), 'kora-limites-'))
    for (const name of ['acima.txt', 'teto.txt', 'acima.xlsx', 'teto.xlsx']) writeFileSync(join(root, name), '')
    truncateSync(join(root, 'acima.txt'), OPEN_LIMITS.textBytes + 1)
    truncateSync(join(root, 'teto.txt'), OPEN_LIMITS.forcedTextBytes + 1)
    truncateSync(join(root, 'acima.xlsx'), OPEN_LIMITS.sheetBytes + 1)
    truncateSync(join(root, 'teto.xlsx'), OPEN_LIMITS.forcedSheetBytes + 1)
    expect(() => readText(root, 'acima.txt')).toThrow(/^Arquivo grande demais/)
    expect(() => readText(root, 'teto.txt', { force: true })).toThrow(/abra no programa padrão/)
    expect(() => readSheetBytes(root, 'acima.xlsx')).toThrow(/^Arquivo grande demais/)
    expect(readSheetBytes(root, 'acima.xlsx', { force: true }).byteLength).toBe(OPEN_LIMITS.sheetBytes + 1)
    expect(() => readSheetBytes(root, 'teto.xlsx', { force: true })).toThrow(/abra no programa padrão/)
  })
})

// Zip mínimo (só deflate) com as partes dadas.
function zip(parts: Record<string, Uint8Array>): Uint8Array {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(parts)) {
    const packed = deflateRawSync(data, { level: 9 })
    const nameBytes = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBytes.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(crc32(data), 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBytes.length, 28)
    dir.writeUInt32LE(offset, 42)
    local.push(head, nameBytes, packed)
    central.push(dir, nameBytes)
    offset += head.length + nameBytes.length + packed.length
  }
  const dirBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(parts).length, 8)
  end.writeUInt16LE(Object.keys(parts).length, 10)
  end.writeUInt32LE(dirBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...local, dirBytes, end]))
}

const text = (s: string): Uint8Array => new Uint8Array(Buffer.from(s))

// Folha de `bytes` bytes que é quase toda espaço: comprime para quase nada e não vira célula nenhuma.
function hollowSheet(bytes: number): Uint8Array {
  const head = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  const tail = '</sheetData></worksheet>'
  const out = Buffer.alloc(bytes, 0x20)
  out.write(head, 0)
  out.write(tail, bytes - tail.length)
  return new Uint8Array(out)
}

describe('teto de descompactação do .xlsx com os limites de produção', () => {
  it('duas folhas de 150 MB: a primeira abre, a segunda passa da soma e é recusada', async () => {
    const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const bytes = zip({
      '_rels/.rels': text(`<Relationships><Relationship Id="r1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
      'xl/workbook.xml': text(`<workbook xmlns:r="${ns}"><sheets><sheet name="A" sheetId="1" r:id="s1"/><sheet name="B" sheetId="2" r:id="s2"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': text(
        `<Relationships><Relationship Id="s1" Type="${ns}/worksheet" Target="worksheets/a.xml"/><Relationship Id="s2" Type="${ns}/worksheet" Target="worksheets/b.xml"/></Relationships>`
      ),
      'xl/worksheets/a.xml': hollowSheet(150 * MB),
      'xl/worksheets/b.xml': hollowSheet(150 * MB)
    })
    expect(bytes.byteLength).toBeLessThan(2 * MB)
    const book = await openXlsx(bytes)
    await expect(book.readSheet(0)).resolves.toEqual([])
    const err = await book.readSheet(1).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(XlsxError)
    expect((err as XlsxError).kind).toBe('too-large')
  }, 60_000)
})
