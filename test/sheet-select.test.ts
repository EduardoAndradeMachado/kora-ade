import { describe, expect, it } from 'vitest'
import { columnLabel, rangeOf, selectionStats, selectionTsv } from '../src/renderer/src/lib/sheet-select'

const ROWS = [
  ['Ana', '1.500', 'a\tb'],
  ['Bia', '12,5', ''],
  ['Caio', 'n/d', 'diz "oi"'],
  ['Dani', '999', 'linha\nnova']
]

describe('columnLabel', () => {
  it('nomeia as colunas como o Excel', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnLabel)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD'])
  })
})

describe('rangeOf', () => {
  it('normaliza a seleção feita de baixo para cima e da direita para a esquerda', () => {
    expect(rangeOf({ anchor: { row: 5, col: 3 }, focus: { row: 1, col: 0 } })).toEqual({ top: 1, left: 0, bottom: 5, right: 3 })
  })
})

describe('selectionStats', () => {
  it('conta as não vazias e soma só os números, com o decimal da coluna (1.500 é mil e quinhentos)', () => {
    const view = [0, 1, 2, 3]
    expect(selectionStats(ROWS, view, { top: 0, left: 0, bottom: 3, right: 2 })).toEqual({ count: 11, numbers: 3, sum: 1500 + 12.5 + 999 })
  })

  it('usa a ordem e as linhas da vista', () => {
    // A vista só tem Bia e Dani: as duas primeiras linhas dela.
    expect(selectionStats(ROWS, [1, 3, 0], { top: 0, left: 1, bottom: 1, right: 1 })).toEqual({ count: 2, numbers: 2, sum: 12.5 + 999 })
  })
})

describe('selectionTsv', () => {
  it('copia o intervalo da vista como TSV, com aspas na célula com tab, quebra de linha ou aspas', () => {
    expect(selectionTsv(ROWS, [2, 0], { top: 0, left: 1, bottom: 1, right: 2 }, null)).toBe('n/d\t"diz ""oi"""\r\n1.500\t"a\tb"')
  })

  it('põe o cabeçalho na primeira linha quando a seleção pega as colunas inteiras', () => {
    const header = ['Nome', 'Valor', 'Obs']
    expect(selectionTsv(ROWS, [0, 1], { top: 0, left: 0, bottom: 1, right: 1 }, header)).toBe('Nome\tValor\r\nAna\t1.500\r\nBia\t12,5')
    expect(selectionTsv(ROWS, [0, 1, 2], { top: 0, left: 0, bottom: 1, right: 0 }, header)).toBe('Ana\r\nBia')
  })
})
