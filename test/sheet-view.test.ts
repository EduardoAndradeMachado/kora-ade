import { describe, expect, it } from 'vitest'
import { distinctValues, filterRows, findMatches, sortRows, viewRows, type ColumnFilter } from '../src/renderer/src/lib/sheet-view'

const ROWS = [
  ['Ana', '1.234,56', '2024-03-01'],
  ['bruno', '99', '2023-12-31'],
  ['Álvaro', '', '2024-01-15'],
  ['Carla', '1.000', ''],
  ['ana', '-5', '2024-03-01']
]

const names = (indices: readonly number[]): string[] => indices.map((i) => ROWS[i]![0]!)

describe('sortRows', () => {
  it('ordena texto em pt-BR sem diferenciar acento nem maiúscula; empate mantém a ordem do arquivo', () => {
    const all = ROWS.map((_, i) => i)
    expect(names(sortRows(ROWS, all, { col: 0, dir: 'asc' }))).toEqual(['Álvaro', 'Ana', 'ana', 'bruno', 'Carla'])
    expect(names(sortRows(ROWS, all, { col: 0, dir: 'desc' }))).toEqual(['Carla', 'bruno', 'Ana', 'ana', 'Álvaro'])
  })

  it('ordena coluna numérica pelo valor e deixa o vazio no fim nos dois sentidos', () => {
    const all = ROWS.map((_, i) => i)
    // A coluna usa vírgula decimal (1.234,56): o 1.000 dela é mil.
    expect(names(sortRows(ROWS, all, { col: 1, dir: 'asc' }))).toEqual(['ana', 'bruno', 'Carla', 'Ana', 'Álvaro'])
    expect(names(sortRows(ROWS, all, { col: 1, dir: 'desc' }))).toEqual(['Ana', 'Carla', 'bruno', 'ana', 'Álvaro'])
  })

  it('na coluna com ponto decimal, 1.000 é um', () => {
    const rows = [['3.14'], ['1.000'], ['2']]
    expect(sortRows(rows, [0, 1, 2], { col: 0, dir: 'asc' }).map((i) => rows[i]![0])).toEqual(['1.000', '2', '3.14'])
  })

  it('ordena datas ISO como data', () => {
    const all = ROWS.map((_, i) => i)
    expect(names(sortRows(ROWS, all, { col: 2, dir: 'asc' }))).toEqual(['bruno', 'Álvaro', 'Ana', 'ana', 'Carla'])
  })

  it('em coluna numérica, o texto fica depois dos números e antes dos vazios', () => {
    const rows = [['10'], [''], ['n/d'], ['2'], ['3'], ['4'], ['5']]
    expect(sortRows(rows, rows.map((_, i) => i), { col: 0, dir: 'desc' }).map((i) => rows[i]![0])).toEqual(['10', '5', '4', '3', '2', 'n/d', ''])
  })

  it('na coluna de texto, o vazio também fica no fim nos dois sentidos', () => {
    const rows = [['b'], [''], ['a'], ['  ']]
    expect(sortRows(rows, [0, 1, 2, 3], { col: 0, dir: 'asc' }).map((i) => rows[i]![0])).toEqual(['a', 'b', '', '  '])
    expect(sortRows(rows, [0, 1, 2, 3], { col: 0, dir: 'desc' }).map((i) => rows[i]![0])).toEqual(['b', 'a', '', '  '])
  })

  it('ordena texto com número pelo número dentro dele (item 2 antes de item 10)', () => {
    const rows = [['item 10'], ['item 2'], ['Item 1']]
    expect(sortRows(rows, [0, 1, 2], { col: 0, dir: 'asc' }).map((i) => rows[i]![0])).toEqual(['Item 1', 'item 2', 'item 10'])
  })
})

describe('filterRows', () => {
  it('tira as linhas com valor desmarcado (texto exato) e as que não contêm o texto, sem acento nem maiúscula', () => {
    const filters = new Map<number, ColumnFilter>([[0, { contains: 'ALVA' }]])
    expect(names(filterRows(ROWS, filters))).toEqual(['Álvaro'])
    const excluded = new Map<number, ColumnFilter>([[0, { excluded: new Set(['Ana']) }]])
    expect(names(filterRows(ROWS, excluded))).toEqual(['bruno', 'Álvaro', 'Carla', 'ana'])
  })

  it('combina os filtros de várias colunas e filtra pela célula vazia', () => {
    const filters = new Map<number, ColumnFilter>([
      [1, { excluded: new Set(['']) }],
      [0, { contains: 'a' }]
    ])
    expect(names(filterRows(ROWS, filters))).toEqual(['Ana', 'Carla', 'ana'])
  })

  it('deixa de fora o filtro da coluna pedida (a lista do autofiltro vê o que os outros deixam)', () => {
    const filters = new Map<number, ColumnFilter>([[0, { contains: 'zzz' }]])
    expect(filterRows(ROWS, filters, 0)).toHaveLength(ROWS.length)
  })
})

describe('viewRows', () => {
  it('filtra e depois ordena', () => {
    const filters = new Map<number, ColumnFilter>([[0, { contains: 'an' }]])
    expect(names(viewRows(ROWS, filters, { col: 1, dir: 'asc' }))).toEqual(['ana', 'Ana'])
  })
})

describe('distinctValues', () => {
  it('conta cada valor diferente, em ordem de número na coluna numérica, com o vazio por último', () => {
    const rows = [['10'], ['2'], [''], ['10'], ['2'], ['10']]
    expect(distinctValues(rows, rows.map((_, i) => i), 0)).toEqual([
      { value: '2', count: 2 },
      { value: '10', count: 3 },
      { value: '', count: 1 }
    ])
  })

  it('só conta as linhas pedidas', () => {
    expect(distinctValues(ROWS, [0, 4], 2)).toEqual([{ value: '2024-03-01', count: 2 }])
  })
})

describe('findMatches', () => {
  it('acha sem acento nem maiúscula, na ordem de leitura, com a posição na vista', () => {
    const view = [4, 0, 2]
    expect(findMatches(ROWS, view, 3, 'alv')).toEqual([{ row: 2, col: 0 }])
    expect(findMatches(ROWS, view, 3, 'ANA')).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 }
    ])
    expect(findMatches(ROWS, view, 3, '2024-03')).toEqual([
      { row: 0, col: 2 },
      { row: 1, col: 2 }
    ])
  })

  it('não procura texto vazio e para no limite', () => {
    expect(findMatches(ROWS, [0, 1], 3, '  ')).toEqual([])
    expect(findMatches(ROWS, [0, 1, 2, 3, 4], 3, '2', 2)).toHaveLength(2)
  })
})
