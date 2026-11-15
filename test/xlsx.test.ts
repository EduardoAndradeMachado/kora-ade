import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSheetBytes } from '../src/main/xlsx'
import { numberStyle, openXlsx, XlsxError } from '../src/renderer/src/lib/xlsx'

// Gerados com openpyxl (com o valor em cache das fórmulas e o sharedStrings.xml como o Excel grava).
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))

async function rejection(promise: Promise<unknown>): Promise<XlsxError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(XlsxError)
  return err as XlsxError
}

describe('openXlsx', () => {
  it('lista as folhas na ordem do arquivo', async () => {
    const book = await openXlsx(fixture('planilha.xlsx'))
    expect(book.sheets.map((s) => s.name)).toEqual(['Vendas', 'Resumo'])
  })

  it('lê texto compartilhado com entidades, número, data, booleano, fórmula pelo valor em cache e texto inline', async () => {
    const rows = await (await openXlsx(fixture('planilha.xlsx'))).readSheet(0)
    expect(rows[0]).toEqual(['Nome', 'Valor', 'Data', 'Ativo', 'Dobro'])
    expect(rows[1]).toEqual(['João & Cia <ltda>', '1234,5', '15/03/2024', 'VERDADEIRO', '2469'])
    // 0.60000000000000009 gravado pelo Excel aparece como 0,6.
    expect(rows[2]).toEqual(['Maria', '0,3', '31/12/2024 13:45:10', 'FALSO', '0,6'])
  })

  it('deixa vazia a célula que falta no meio da linha, sem puxar as seguintes para a esquerda', async () => {
    const rows = await (await openXlsx(fixture('planilha.xlsx'))).readSheet(0)
    expect(rows[3]).toEqual(['Pedro', '', '01/01/1900', '', 'sete'])
  })

  it('junta os trechos de texto formatado e deixa de fora a leitura fonética', async () => {
    const rows = await (await openXlsx(fixture('planilha.xlsx'))).readSheet(0)
    expect(rows[4]).toEqual(['Negrito normal', '42,00'])
  })

  it('lê a segunda folha: porcentagem, hora, quebra de linha e linhas em branco no meio', async () => {
    const rows = await (await openXlsx(fixture('planilha.xlsx'))).readSheet(1)
    expect(rows).toEqual([['Taxa', '12,50%'], ['Hora', '08:30:00'], ['Linha\ncom quebra'], [], [], ['depois do buraco']])
  })

  it('para de descompactar no teto de cada parte', async () => {
    // styles.xml tem 3.196 bytes descompactados.
    expect((await rejection(openXlsx(fixture('planilha.xlsx'), { partBytes: 3_000, totalBytes: 1_000_000 }))).kind).toBe('too-large')
    await expect(openXlsx(fixture('planilha.xlsx'), { partBytes: 3_196, totalBytes: 1_000_000 })).resolves.toBeDefined()
  })

  it('soma no teto total o que já foi descompactado das outras partes', async () => {
    // Na abertura saem 5.675 bytes (rels, workbook, sharedStrings, styles); a folha 1 tem 1.208 e a 2, 833.
    const limits = { partBytes: 1_000_000, totalBytes: 7_000 }
    await expect((await openXlsx(fixture('planilha.xlsx'), limits)).readSheet(0)).resolves.toHaveLength(5)
    const book = await openXlsx(fixture('planilha.xlsx'), limits)
    await book.readSheet(1)
    expect((await rejection(book.readSheet(0))).kind).toBe('too-large')
  })

  it('recusa a zip bomb (270 MB numa parte de 270 KB) com os limites de produção', async () => {
    const book = await openXlsx(fixture('planilha-bomba.xlsx'))
    const err = await rejection(book.readSheet(0))
    expect(err.kind).toBe('too-large')
  })

  it('reconhece o arquivo protegido por senha (contêiner OLE) e o que não é zip', async () => {
    const ole = new Uint8Array(512)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect((await rejection(openXlsx(ole))).kind).toBe('protected')
    expect((await rejection(openXlsx(new TextEncoder().encode('nome;valor\n1;2')))).kind).toBe('corrupt')
  })

  it('acusa corrompido o xlsx cortado no meio', async () => {
    const bytes = fixture('planilha.xlsx')
    const cut = bytes.slice(0, Math.floor(bytes.length / 2))
    expect((await rejection(openXlsx(cut))).kind).toBe('corrupt')
  })

  it('acusa corrompido o dado compactado estragado', async () => {
    const bytes = fixture('planilha.xlsx')
    const broken = bytes.slice()
    // Bagunça o começo de cada parte compactada (logo depois do cabeçalho local), mantendo o diretório intacto.
    const view = new DataView(broken.buffer)
    for (let i = 0; i + 30 < broken.length; i++) {
      if (view.getUint32(i, true) !== 0x04034b50) continue
      const start = i + 30 + view.getUint16(i + 26, true) + view.getUint16(i + 28, true)
      for (let k = 0; k < 8 && start + k < broken.length; k++) broken[start + k] = 0xff
    }
    expect((await rejection(openXlsx(broken))).kind).toBe('corrupt')
  })
})

describe('numberStyle', () => {
  it('reconhece data e hora no formato personalizado, ignorando texto entre aspas e [cor]', () => {
    expect(numberStyle(164, 'dd/mm/yyyy')).toMatchObject({ kind: 'date', date: true, time: false })
    expect(numberStyle(165, '[h]:mm:ss')).toMatchObject({ kind: 'date', date: false, time: true, seconds: true })
    expect(numberStyle(166, '0.00 "dias"')).toEqual({ kind: 'fixed', decimals: 2 })
    expect(numberStyle(167, '[Red]#,##0')).toEqual({ kind: 'fixed', decimals: 0 })
    expect(numberStyle(14, undefined)).toMatchObject({ kind: 'date', date: true })
    expect(numberStyle(0, undefined)).toEqual({ kind: 'general' })
  })
})

describe('readSheetBytes', () => {
  let parent: string
  let root: string
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'kora-xlsx-'))
    root = join(parent, 'projeto')
    mkdirSync(root)
  })
  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  it('entrega os bytes do arquivo do projeto, que o leitor abre', async () => {
    copyFileSync(join(__dirname, 'fixtures', 'planilha.xlsx'), join(root, 'dados.xlsx'))
    const book = await openXlsx(readSheetBytes(root, 'dados.xlsx'))
    expect(book.sheets.map((s) => s.name)).toEqual(['Vendas', 'Resumo'])
  })

  it('recusa caminho fora do projeto', () => {
    writeFileSync(join(parent, 'fora.xlsx'), 'x')
    expect(() => readSheetBytes(root, '../fora.xlsx')).toThrow(/fora do projeto/)
  })

  it('pede "Abrir mesmo assim" acima de 5 MB e recusa acima de 50 MB mesmo forçado', () => {
    const big = join(root, 'grande.xlsx')
    writeFileSync(big, '')
    truncateSync(big, 5 * 1024 * 1024 + 1)
    expect(() => readSheetBytes(root, 'grande.xlsx')).toThrow(/^Arquivo grande demais para abrir aqui/)
    expect(readSheetBytes(root, 'grande.xlsx', { force: true }).byteLength).toBe(5 * 1024 * 1024 + 1)
    truncateSync(big, 50 * 1024 * 1024 + 1)
    expect(() => readSheetBytes(root, 'grande.xlsx', { force: true })).toThrow(/^Arquivo acima de 50 MB/)
  })
})
