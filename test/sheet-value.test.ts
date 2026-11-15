import { describe, expect, it } from 'vitest'
import { columnKind, decimalMarkOf, foldText, parseDate, parseNumber } from '../src/renderer/src/lib/sheet-value'

describe('parseNumber', () => {
  it('lê o número em pt-BR e em inglês pelo último separador', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56)
    expect(parseNumber('1,234.56')).toBe(1234.56)
    expect(parseNumber('1.234.567')).toBe(1234567)
    expect(parseNumber('1,234,567.5')).toBe(1234567.5)
  })

  it('separador uma vez só é decimal, dos dois jeitos', () => {
    expect(parseNumber('12,5')).toBe(12.5)
    expect(parseNumber('3.14')).toBe(3.14)
    expect(parseNumber(',5')).toBe(0.5)
  })

  it('aceita sinal, moeda, porcentagem, parênteses de negativo e expoente', () => {
    expect(parseNumber('-R$ 1.234,50')).toBe(-1234.5)
    expect(parseNumber('R$ -10')).toBe(-10)
    expect(parseNumber('12,5%')).toBe(0.125)
    expect(parseNumber('(300)')).toBe(-300)
    expect(parseNumber('1,5E+20')).toBe(1.5e20)
    expect(parseNumber('  42  ')).toBe(42)
  })

  it('recusa o que não é número: milhar com grupo errado, texto, data, hora, vazio', () => {
    expect(parseNumber('1.23.4')).toBeNull()
    expect(parseNumber('1.234,5,6')).toBeNull()
    expect(parseNumber('12a')).toBeNull()
    expect(parseNumber('2024-01-05')).toBeNull()
    expect(parseNumber('12:30')).toBeNull()
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('-')).toBeNull()
    expect(parseNumber('.')).toBeNull()
  })
})

describe('decimalMarkOf e parseNumber com o decimal da coluna', () => {
  it('acha o decimal da coluna pelos valores sem dúvida e lê 1.000 como mil (ou um) por ele', () => {
    expect(decimalMarkOf(['R$ 999', 'R$ 1.500', 'R$ 12,90'])).toBe(',')
    expect(decimalMarkOf(['1,000', '2.5'])).toBe('.')
    expect(decimalMarkOf(['1.234.567', '10'])).toBe(',')
    expect(decimalMarkOf(['1.000', '2.000', 'texto'])).toBeNull()
    expect(parseNumber('1.000', ',')).toBe(1000)
    expect(parseNumber('1,000', '.')).toBe(1000)
    expect(parseNumber('1.000', '.')).toBe(1)
    expect(parseNumber('1.000')).toBe(1)
  })
})

describe('parseDate', () => {
  it('lê data ISO, com e sem hora, e dd/mm/aaaa', () => {
    expect(parseDate('2024-03-15')).toBe(Date.UTC(2024, 2, 15))
    expect(parseDate('2024-03-15T10:20:30')).toBe(Date.UTC(2024, 2, 15, 10, 20, 30))
    expect(parseDate('2024-03-15T10:20:30Z')).toBe(Date.UTC(2024, 2, 15, 10, 20, 30))
    expect(parseDate('15/03/2024')).toBe(Date.UTC(2024, 2, 15))
    expect(parseDate('31/12/2024 13:45:10')).toBe(Date.UTC(2024, 11, 31, 13, 45, 10))
  })

  it('recusa data que não existe e texto', () => {
    expect(parseDate('2024-02-30')).toBeNull()
    expect(parseDate('31/02/2024')).toBeNull()
    expect(parseDate('2024-13-01')).toBeNull()
    expect(parseDate('amanhã')).toBeNull()
  })
})

describe('foldText', () => {
  it('ignora acento e maiúscula', () => {
    expect(foldText('JOÃO Ação')).toBe('joao acao')
    expect(foldText('Joa\u0303o')).toBe('joao')
  })
})

describe('columnKind', () => {
  it('é numérica com quase tudo número, mesmo com um "n/d" no meio; vazio não conta', () => {
    expect(columnKind(['1', '2,5', '', '3', '4', 'n/d', '5', '6', '7', '8', '9'])).toBe('number')
    expect(columnKind(['2024-01-01', '05/02/2024', ''])).toBe('date')
    expect(columnKind(['1', 'a', 'b'])).toBe('text')
    expect(columnKind(['', ''])).toBe('text')
  })
})
