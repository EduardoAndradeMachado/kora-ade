import { describe, expect, it } from 'vitest'
import { MIN_CONTENT, minWindowSize } from '../src/main/window-size'

const bigScreen = { width: 2560, height: 1400 }

describe('tamanho mínimo da janela', () => {
  it('com zoom 100% é o mínimo do conteúdo, que cabe as duas laterais e a área central', () => {
    expect(minWindowSize(1, bigScreen)).toEqual({ width: MIN_CONTENT.width, height: MIN_CONTENT.height })
    // 256 (lateral) + 288 (painel direito) + área central de pelo menos 416 px.
    expect(MIN_CONTENT.width - 256 - 288).toBeGreaterThanOrEqual(416)
  })

  it('cresce junto com o zoom da interface', () => {
    expect(minWindowSize(1.25, bigScreen)).toEqual({ width: 1200, height: 700 })
    expect(minWindowSize(0.8, bigScreen)).toEqual({ width: 768, height: 448 })
  })

  it('nunca passa da área útil do monitor', () => {
    expect(minWindowSize(1.5, { width: 1366, height: 728 })).toEqual({ width: 1366, height: 728 })
  })

  it('zoom inválido vale como 100%', () => {
    expect(minWindowSize(Number.NaN, bigScreen)).toEqual({ width: 960, height: 560 })
    expect(minWindowSize(0, bigScreen)).toEqual({ width: 960, height: 560 })
  })
})
