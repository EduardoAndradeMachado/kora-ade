import { describe, expect, it } from 'vitest'
import { keepMounted, visibleRange } from '../src/renderer/src/lib/virtual-range'

const ROW = 24

// Toda linha que cruza a área visível [top, top + height) precisa estar no intervalo devolvido.
function mustShow(top: number, height: number, listTop: number, count: number): number[] {
  const rows: number[] = []
  for (let i = 0; i < count; i++) {
    const rowTop = listTop + i * ROW
    if (rowTop < top + height && rowTop + ROW > top) rows.push(i)
  }
  return rows
}

describe('visibleRange', () => {
  it('cobre toda linha que aparece, com a lista abaixo de outras seções e a janela em qualquer ponto', () => {
    const count = 3000
    for (const step of [1, 10]) {
      for (const listTop of [0, 137, 900]) {
        for (const top of [0, 50, 137, 1000, 24 * 1500 + 7, 24 * 2990, 24 * 3000 + 900]) {
          for (const height of [0, 23, 600, 1200]) {
            const { start, end } = visibleRange(top, height, listTop, count, ROW, 0, step)
            const where = `step=${step} listTop=${listTop} top=${top} height=${height}`
            for (const i of mustShow(top, height, listTop, count)) {
              expect(i, where).toBeGreaterThanOrEqual(start)
              expect(i, where).toBeLessThan(end)
            }
          }
        }
      }
    }
  })

  it('monta só a vizinhança da janela, não a lista inteira', () => {
    const { start, end } = visibleRange(24 * 1500, 600, 0, 3000, ROW, 20)
    expect(start).toBe(1480)
    expect(end).toBe(1545)
  })

  it('em blocos, rolar uma linha não muda a faixa', () => {
    const at = (row: number) => visibleRange(24 * row, 600, 0, 3000, ROW, 20, 10)
    expect(at(1501)).toEqual(at(1500))
    expect(at(1505)).toEqual(at(1500))
    expect(at(1500).start % 10).toBe(0)
    expect(at(1500).end % 10).toBe(0)
  })

  it('fica dentro dos limites da lista nas pontas e com a lista fora da tela', () => {
    expect(visibleRange(0, 600, 0, 10, ROW, 20)).toEqual({ start: 0, end: 10 })
    expect(visibleRange(0, 600, 5000, 3000, ROW, 20)).toEqual({ start: 0, end: 0 })
    expect(visibleRange(10_000, 600, 0, 100, ROW, 20)).toEqual({ start: 100, end: 100 })
  })
})

describe('keepMounted', () => {
  it('estica a faixa até a linha em edição, acima ou abaixo, sem tirar nada do que já estava montado', () => {
    expect(keepMounted({ start: 100, end: 160 }, 5, 3000)).toEqual({ start: 5, end: 160 })
    expect(keepMounted({ start: 100, end: 160 }, 2000, 3000)).toEqual({ start: 100, end: 2001 })
    expect(keepMounted({ start: 100, end: 160 }, 120, 3000)).toEqual({ start: 100, end: 160 })
  })

  it('ignora índice ausente ou fora da lista', () => {
    for (const keep of [undefined, -1, 3000]) expect(keepMounted({ start: 100, end: 160 }, keep, 3000)).toEqual({ start: 100, end: 160 })
  })
})
