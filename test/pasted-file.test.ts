import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_PASTED_FILE_BYTES, safeFileName, savePastedFile } from '../src/main/pasted-file'

describe('arquivo anexado pelo celular', () => {
  it('guarda com o nome original numa pasta própria por envio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-anexo-'))
    const bytes = Buffer.from('a;b\n1;2')
    const first = savePastedFile(dir, bytes, 'Relatório 2026.csv')
    const second = savePastedFile(dir, bytes, 'Relatório 2026.csv')
    expect(basename(first)).toBe('Relatório 2026.csv')
    expect(dirname(dirname(first))).toBe(dir)
    expect(first).not.toBe(second)
    expect(readFileSync(first).equals(bytes)).toBe(true)
  })

  it('nome vindo de fora não sai da pasta nem vira nome que o Windows recusa', () => {
    expect(safeFileName('..\\..\\Windows\\win.ini')).toBe('win.ini')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('a<b>:c"d|e?f*.txt')).toBe('a_b__c_d_e_f_.txt')
    // Colado no terminal, nada do nome pode virar comando no PowerShell, no cmd ou no bash.
    expect(safeFileName("nota $(Start-Process calc);x&y%PATH%`z'O^!{a}[b]~.pdf")).toBe('nota __Start-Process calc__x_y_PATH__z_O___a__b__.pdf')
    expect(safeFileName('Relatório final #2 (v3).pdf')).toBe('Relatório final #2 _v3_.pdf')
    expect(safeFileName('CON')).toBe('_CON')
    expect(safeFileName('nul.txt')).toBe('_nul.txt')
    expect(safeFileName('relatorio. . ')).toBe('relatorio')
    for (const empty of ['', '..', '/', '   ']) expect(safeFileName(empty)).toBe('arquivo')
    const long = safeFileName(`${'x'.repeat(300)}.pdf`)
    expect(long.length).toBe(120)
    expect(long.endsWith('.pdf')).toBe(true)
  })

  it('recusa vazio e grande demais', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-anexo-'))
    expect(() => savePastedFile(dir, new Uint8Array(), 'a.txt')).toThrow(/vazio/)
    expect(() => savePastedFile(dir, new Uint8Array(MAX_PASTED_FILE_BYTES + 1), 'a.txt')).toThrow(/grande/)
  })
})
