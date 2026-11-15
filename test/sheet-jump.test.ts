import { describe, expect, it } from 'vitest'
import { parseCsv, type Delimiter } from '../src/renderer/src/lib/csv'
import { csvRecordAtLine, sheetJumpFor } from '../src/renderer/src/lib/sheet-jump'

// O que a grade mostraria na linha para onde o `arquivo.csv:N` leva: a mesma leitura que a planilha faz.
function rowAtLine(text: string, line: number, hasHeader: boolean, delimiter: Delimiter = ','): string[] | 'cabeçalho' | null {
  const all = parseCsv(text, delimiter)
  const body = hasHeader ? all.slice(1) : all
  const jump = sheetJumpFor(csvRecordAtLine(text, delimiter, line), hasHeader)
  if (!jump) return null
  return jump.kind === 'header' ? 'cabeçalho' : body[jump.row]!
}

describe('linha do arquivo → linha da planilha', () => {
  it('com cabeçalho, a linha 1 é o cabeçalho e a 3 é o segundo dado', () => {
    const text = 'nome;idade\nAna;30\nBia;41\n'
    expect(rowAtLine(text, 1, true, ';')).toBe('cabeçalho')
    expect(rowAtLine(text, 3, true, ';')).toEqual(['Bia', '41'])
    expect(rowAtLine(text, 1, false, ';')).toEqual(['nome', 'idade'])
  })

  it('campo entre aspas com quebra de linha ocupa várias linhas do arquivo', () => {
    const text = 'id,obs\n1,"primeira\nsegunda\nterceira"\n2,curta\n3,fim\n'
    expect(rowAtLine(text, 2, true)).toEqual(['1', 'primeira\nsegunda\nterceira'])
    expect(rowAtLine(text, 4, true)).toEqual(['1', 'primeira\nsegunda\nterceira'])
    expect(rowAtLine(text, 5, true)).toEqual(['2', 'curta'])
    expect(rowAtLine(text, 6, true)).toEqual(['3', 'fim'])
  })

  it('CRLF, CR sozinho e BOM contam como o editor conta', () => {
    expect(rowAtLine('﻿a,b\r\n1,2\r\n3,4\r\n', 3, true)).toEqual(['3', '4'])
    expect(rowAtLine('a,b\r1,2\r3,4', 2, false)).toEqual(['1', '2'])
    expect(rowAtLine('a,b\r\n"x\r\ny",2\r\nz,3', 4, false)).toEqual(['z', '3'])
  })

  it('linha em branco no meio é uma linha; além do fim cai na última', () => {
    const text = 'a,b\n\nc,d\n'
    expect(rowAtLine(text, 3, false)).toEqual(['c', 'd'])
    expect(rowAtLine(text, 99, false)).toEqual(['c', 'd'])
  })

  it('arquivo vazio não tem para onde ir', () => {
    expect(rowAtLine('', 3, false)).toBeNull()
  })
})
