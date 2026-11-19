import { describe, expect, it } from 'vitest'
import { agyCost, claudeContextWindow, claudeCost, type ClaudeUsage } from '../src/main/pricing'

const M = 1_000_000
const none: ClaudeUsage = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, fast: false }
const only = (field: keyof Omit<ClaudeUsage, 'fast'>, fast = false): ClaudeUsage => ({ ...none, [field]: M, fast })

// Valores da tabela de preços da Anthropic (US$ por milhão de tokens), copiados da página e não da tabela do Kora:
// entrada, gravação de cache de 5 min e de 1 h, leitura de cache e saída.
const PUBLISHED: Record<string, [number, number, number, number, number]> = {
  'claude-fable-5-2': [8, 10, 16, 0.2, 40],
  'claude-mythos-5-2': [8, 10, 16, 0.2, 40],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10]
}

describe('preço de API do Claude', () => {
  for (const [model, [input, write5m, write1h, read, output]] of Object.entries(PUBLISHED)) {
    it(`${model} cobra o que a Anthropic publica em cada tipo de token`, () => {
      expect(claudeCost(model, only('input'))).toBeCloseTo(input)
      expect(claudeCost(model, only('cacheWrite5m'))).toBeCloseTo(write5m)
      expect(claudeCost(model, only('cacheWrite1h'))).toBeCloseTo(write1h)
      expect(claudeCost(model, only('cacheRead'))).toBeCloseTo(read)
      expect(claudeCost(model, only('output'))).toBeCloseTo(output)
    })
  }

  it('modo rápido do Fable 5.2 custa US$ 16 de entrada e US$ 80 de saída', () => {
    expect(claudeCost('claude-fable-5-2', only('input', true))).toBeCloseTo(16)
    expect(claudeCost('claude-fable-5-2', only('output', true))).toBeCloseTo(80)
  })

  it('Fable 5.2 com sufixo de variante tem a janela de 1M', () => {
    expect(claudeContextWindow('claude-fable-5-2[1m]')).toBe(M)
  })
})

// Valores do Gemini API (aistudio.google.com/docs/pricing, lido em 2026-11-17), copiados da página: entrada, cache
// lido e saída. Carbon dobra em 1/12/2026 e o 3.8 Flash em 1/1/2027.
describe('preço de API dos modelos do agy', () => {
  const NOV = Date.UTC(2026, 10, 17)
  const DEC = Date.UTC(2026, 11, 2)
  const JAN = Date.UTC(2027, 0, 2)
  const cost = (model: string, at: number): [number | null, number | null, number | null] => [
    agyCost(model, at, { input: M, cached: 0, output: 0 }),
    agyCost(model, at, { input: 0, cached: M, output: 0 }),
    agyCost(model, at, { input: 0, cached: 0, output: M })
  ]

  it('Neon tem preço fixo, sem data para mudar (lido em 2026-11-18)', () => {
    expect(cost('gemini-4-neon', NOV)).toEqual([3, 0.15, 15])
    expect(cost('gemini-4-neon', JAN)).toEqual([3, 0.15, 15])
    expect(cost('gemini-4-neon-tiered-high', NOV)).toEqual([3, 0.15, 15])
  })

  it('Carbon cobra o preço do dia em que a resposta terminou', () => {
    expect(cost('gemini-4-carbon', NOV)).toEqual([2, 0.1, 10])
    expect(cost('gemini-4-carbon', DEC)).toEqual([4, 0.2, 20])
  })

  it('3.8 Flash mantém o preço em dezembro e dobra em janeiro', () => {
    expect(cost('gemini-3.8-flash', DEC)).toEqual([0.75, 0.075, 3.75])
    expect(cost('gemini-3.8-flash', JAN)).toEqual([1.5, 0.15, 7.5])
  })

  it('variante gravada pelo agy cobra o modelo base', () => {
    expect(cost('gemini-4-hydrogen-tiered-high', NOV)).toEqual([1.5, 0.075, 7.5])
    expect(cost('gemini-3.8-flash-n', NOV)).toEqual([0.75, 0.075, 3.75])
    expect(cost('gemini-3.8-flash-tiered', NOV)).toEqual([0.75, 0.075, 3.75])
  })

  it('Claude pelo agy usa a tabela da Anthropic, sem o sufixo -thinking', () => {
    expect(cost('claude-opus-4-6-thinking', NOV)).toEqual([5, 0.5, 25])
  })

  it('modelo fora da tabela fica sem preço', () => {
    expect(agyCost('gemini-flash-safety-le2', NOV, { input: M, cached: 0, output: 0 })).toBeNull()
    expect(agyCost('desconhecido', NOV, { input: M, cached: 0, output: 0 })).toBeNull()
  })
})
