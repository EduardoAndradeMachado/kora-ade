import { describe, expect, it } from 'vitest'
import { detectDelimiter, detectHeader, parseCsv, toTsv } from '../src/renderer/src/lib/csv'

describe('parseCsv', () => {
  it('separa campos e linhas com CRLF, LF e CR', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f\rg,h', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h']
    ])
  })

  it('lê aspas, aspas dobradas e separador ou quebra de linha dentro das aspas', () => {
    expect(parseCsv('"a,1","diz ""oi""","linha 1\r\nlinha 2"\r\nx,y,z', ',')).toEqual([
      ['a,1', 'diz "oi"', 'linha 1\r\nlinha 2'],
      ['x', 'y', 'z']
    ])
  })

  it('tira o BOM do começo e não cria registro vazio pela quebra de linha final', () => {
    expect(parseCsv('\uFEFFnome;valor\r\nAna;1\r\n', ';')).toEqual([
      ['nome', 'valor'],
      ['Ana', '1']
    ])
  })

  it('mantém campos vazios, inclusive o último da linha, e a linha com menos colunas', () => {
    expect(parseCsv('a,,c,\nsó', ',')).toEqual([['a', '', 'c', ''], ['só']])
  })

  it('mantém a linha em branco do meio como linha vazia', () => {
    expect(parseCsv('a\n\nb', ',')).toEqual([['a'], [''], ['b']])
  })

  it('aspa sem par vai até o fim e texto depois da aspa que fecha entra no campo, como o Excel faz', () => {
    expect(parseCsv('"abc"def,g\n"sem fim,x\ny', ',')).toEqual([['abcdef', 'g'], ['sem fim,x\ny']])
  })

  it('aspas no meio de um campo sem aspas são texto', () => {
    expect(parseCsv('5" polegadas,b', ',')).toEqual([['5" polegadas', 'b']])
  })

  it('para no número de registros pedido', () => {
    expect(parseCsv('1\n2\n3\n4', ',', 2)).toEqual([['1'], ['2']])
  })

  it('devolve nada para o arquivo vazio ou só com BOM', () => {
    expect(parseCsv('', ',')).toEqual([])
    expect(parseCsv('\uFEFF', ',')).toEqual([])
  })
})

describe('detectDelimiter', () => {
  it('escolhe ; no CSV brasileiro mesmo com vírgula decimal em toda linha', () => {
    expect(detectDelimiter('produto;preço;qtd\nCafé;12,50;3\nPão;0,75;10\nLeite;4,99;2')).toBe(';')
  })

  it('escolhe , quando ; só aparece às vezes dentro do texto', () => {
    expect(detectDelimiter('id,nota\n1,ok; revisar\n2,bom\n3,ruim')).toBe(',')
  })

  it('reconhece tab e barra vertical', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a|b\n1|2\n3|4')).toBe('|')
  })

  it('não conta o separador que está dentro de aspas', () => {
    expect(detectDelimiter('"a;b";"c;d"\n"1,5";"2,5"\n"x";"y"')).toBe(';')
    expect(detectDelimiter('nome,obs\n"Ana","a;b;c"\n"Bia","d;e;f"')).toBe(',')
  })

  it('cai no padrão quando nada separa em colunas', () => {
    expect(detectDelimiter('uma coluna\nsó')).toBe(',')
    expect(detectDelimiter('uma coluna\nsó', '\t')).toBe('\t')
  })
})

describe('detectHeader', () => {
  it('vê cabeçalho quando a primeira linha só tem rótulos diferentes', () => {
    expect(detectHeader([['Nome', 'Valor'], ['Ana', '10']])).toBe(true)
  })

  it('não vê cabeçalho com número, data, vazio ou rótulo repetido na primeira linha', () => {
    expect(detectHeader([['Ana', '10'], ['Bia', '20']])).toBe(false)
    expect(detectHeader([['2024-01-05', 'x'], ['b', 'c']])).toBe(false)
    expect(detectHeader([['Nome', ''], ['Ana', '1']])).toBe(false)
    expect(detectHeader([['Nome', 'NOME'], ['Ana', 'Bia']])).toBe(false)
  })

  it('não vê cabeçalho numa linha só', () => {
    expect(detectHeader([['Nome', 'Valor']])).toBe(false)
  })
})

describe('toTsv', () => {
  it('separa por tab e CRLF e põe entre aspas a célula com tab, quebra de linha ou aspas', () => {
    expect(
      toTsv([
        ['a', 'b\tc'],
        ['linha\nnova', 'diz "oi"'],
        ['', 'fim']
      ])
    ).toBe('a\t"b\tc"\r\n"linha\nnova"\t"diz ""oi"""\r\n\tfim')
  })
})
