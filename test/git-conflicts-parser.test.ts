import { describe, expect, it } from 'vitest'
import { parseConflicts, resolveAll, resolveConflict, splitLines } from '../src/renderer/src/lib/git-conflicts'

const MERGE = ['antes', '<<<<<<< HEAD', 'nosso 1', 'nosso 2', '=======', 'deles', '>>>>>>> feature', 'depois', ''].join('\n')

const first = (text: string) => {
  const [block] = parseConflicts(splitLines(text))
  if (!block) throw new Error('nenhum bloco')
  return block
}

describe('parseConflicts', () => {
  it('acha o bloco, os rótulos e as faixas de cada lado (linhas a partir de 1)', () => {
    expect(parseConflicts(splitLines(MERGE))).toEqual([
      {
        startLine: 2,
        separatorLine: 5,
        endLine: 7,
        baseLine: null,
        current: { start: 3, end: 4 },
        base: null,
        incoming: { start: 6, end: 6 },
        currentLabel: 'HEAD',
        incomingLabel: 'feature'
      }
    ])
  })

  it('diff3: a base fica separada e não entra no lado atual', () => {
    const text = ['<<<<<<< HEAD', 'nosso', '||||||| base comum', 'original', '=======', 'deles', '>>>>>>> outra'].join('\n')
    expect(first(text)).toMatchObject({ baseLine: 3, current: { start: 2, end: 2 }, base: { start: 4, end: 4 }, incoming: { start: 6, end: 6 } })
  })

  it('CRLF: o \\r não atrapalha os marcadores nem vai para o rótulo', () => {
    const block = first(MERGE.replace(/\n/g, '\r\n'))
    expect(block).toMatchObject({ startLine: 2, separatorLine: 5, endLine: 7, currentLabel: 'HEAD', incomingLabel: 'feature' })
  })

  it('marcador no meio da linha, oito sinais ou bloco sem fim não são conflito', () => {
    expect(parseConflicts(splitLines('const s = "<<<<<<< HEAD"\n=======\n>>>>>>> x'))).toEqual([])
    expect(parseConflicts(splitLines('<<<<<<<< oito\na\n=======\nb\n>>>>>>>> oito'))).toEqual([])
    expect(parseConflicts(splitLines('<<<<<<< HEAD\na\n=======\nb\n'))).toEqual([])
  })

  it('início novo antes do fim descarta o incompleto; vários blocos saem em ordem', () => {
    const text = ['<<<<<<< solto', 'x', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> f', 'meio', '<<<<<<< HEAD', '=======', 'c', '>>>>>>> f'].join('\n')
    const blocks = parseConflicts(splitLines(text))
    expect(blocks.map((b) => [b.startLine, b.endLine])).toEqual([
      [3, 7],
      [9, 12]
    ])
    // Lado vazio: end < start.
    expect(blocks[1]!.current).toEqual({ start: 10, end: 9 })
  })

  it('"=======" de sublinhado de título fora de bloco é ignorado', () => {
    expect(parseConflicts(splitLines('Título\n=======\n'))).toEqual([])
  })
})

describe('resolver um bloco', () => {
  it('atual, entrada e ambas trocam o bloco inteiro e mantêm o resto', () => {
    const block = first(MERGE)
    expect(resolveConflict(MERGE, block, 'current')).toBe('antes\nnosso 1\nnosso 2\ndepois\n')
    expect(resolveConflict(MERGE, block, 'incoming')).toBe('antes\ndeles\ndepois\n')
    expect(resolveConflict(MERGE, block, 'both')).toBe('antes\nnosso 1\nnosso 2\ndeles\ndepois\n')
  })

  it('diff3: aceitar ambas não leva a base junto', () => {
    const text = ['<<<<<<< HEAD', 'nosso', '||||||| base', 'original', '=======', 'deles', '>>>>>>> outra', 'fim'].join('\n')
    expect(resolveConflict(text, first(text), 'both')).toBe('nosso\ndeles\nfim')
  })

  it('CRLF continua CRLF', () => {
    const text = MERGE.replace(/\n/g, '\r\n')
    expect(resolveConflict(text, first(text), 'incoming')).toBe('antes\r\ndeles\r\ndepois\r\n')
  })

  it('bloco no fim do arquivo sem quebra final, e lado vazio, não deixam linha sobrando', () => {
    const text = 'antes\n<<<<<<< HEAD\nnosso\n=======\n>>>>>>> f'
    expect(resolveConflict(text, first(text), 'current')).toBe('antes\nnosso')
    expect(resolveConflict(text, first(text), 'incoming')).toBe('antes')
    const only = '<<<<<<< HEAD\nnosso\n=======\ndeles\n>>>>>>> f'
    expect(resolveConflict(only, first(only), 'incoming')).toBe('deles')
  })

  it('resolveAll aplica o mesmo lado em todos os blocos (os dois lados do Comparar)', () => {
    const text = ['<<<<<<< HEAD', 'a1', '=======', 'b1', '>>>>>>> f', 'meio', '<<<<<<< HEAD', 'a2', '=======', 'b2', '>>>>>>> f', ''].join('\n')
    expect(resolveAll(text, 'current')).toBe('a1\nmeio\na2\n')
    expect(resolveAll(text, 'incoming')).toBe('b1\nmeio\nb2\n')
  })
})
