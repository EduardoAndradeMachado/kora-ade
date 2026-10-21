import { describe, expect, it } from 'vitest'
import { bucketMedians, bucketSize } from '../src/renderer/src/lib/metrics-format'

const MIN = 60_000

describe('bucketMedians', () => {
  it('dá a mediana de cada faixa e null onde não houve resposta, para a linha se interromper', () => {
    const start = 0
    const points = [
      { at: 1 * MIN, value: 80 },
      { at: 2 * MIN, value: 100 },
      { at: 3 * MIN, value: 90 },
      // 10–20 min sem resposta
      { at: 25 * MIN, value: 120 }
    ]
    expect(bucketMedians(points, start, 30 * MIN, 10 * MIN)).toEqual([90, null, 120])
  })

  it('ignora resposta fora do período do gráfico', () => {
    expect(bucketMedians([{ at: -MIN, value: 50 }, { at: 40 * MIN, value: 50 }], 0, 20 * MIN, 10 * MIN)).toEqual([null, null])
  })
})

describe('bucketSize', () => {
  it('alarga a faixa conforme o período cresce', () => {
    expect(bucketSize(2 * 60 * MIN)).toBe(10 * MIN)
    expect(bucketSize(6 * 60 * MIN)).toBe(20 * MIN)
    expect(bucketSize(14 * 60 * MIN)).toBe(30 * MIN)
  })
})
