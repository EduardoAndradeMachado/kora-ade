import { describe, expect, it } from 'vitest'
import { claudeContextWindow, claudeCost, type ClaudeUsage } from '../src/main/pricing'

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
