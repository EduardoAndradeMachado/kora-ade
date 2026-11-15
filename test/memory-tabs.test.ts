import { describe, expect, it } from 'vitest'
import { pickTabsToUnload, pressureNotice, tabCost, type TabMemoryCandidate } from '../src/renderer/src/lib/memory-tabs'
import { OPEN_LIMITS } from '../src/shared/open-limits'

const MB = 1024 * 1024
const tab = (id: string, lastShown: number, cost: number, extra: Partial<TabMemoryCandidate> = {}): TabMemoryCandidate => ({
  id,
  visible: false,
  dirty: false,
  lastShown,
  cost,
  ...extra
})

describe('pickTabsToUnload', () => {
  it('descarrega primeiro a aba escondida há mais tempo, até cobrir o que falta', () => {
    const tabs = [tab('nova', 300, 100), tab('velha', 100, 100), tab('meio', 200, 100)]
    expect(pickTabsToUnload(tabs, 150)).toEqual(['velha', 'meio'])
    expect(pickTabsToUnload(tabs, 100)).toEqual(['velha'])
  })

  it('nunca escolhe a aba na frente nem a que tem alteração não salva, mesmo faltando memória', () => {
    const tabs = [tab('ativa', 0, 500, { visible: true }), tab('suja', 1, 500, { dirty: true }), tab('limpa', 2, 10)]
    expect(pickTabsToUnload(tabs, 10_000)).toEqual(['limpa'])
  })

  it('sem falta de memória não descarrega nada; aba sem peso estimado não entra', () => {
    const tabs = [tab('a', 1, 100), tab('pdf', 0, 0)]
    expect(pickTabsToUnload(tabs, 0)).toEqual([])
    expect(pickTabsToUnload(tabs, -5)).toEqual([])
    expect(pickTabsToUnload(tabs, 1000)).toEqual(['a'])
  })
})

describe('tabCost', () => {
  const md = { viewer: 'markdown' as const, editing: false }

  it('Markdown visualizado pesa muito mais que o mesmo arquivo em Editar; Lado a lado soma os dois', () => {
    const preview = tabCost(md, MB)
    const edit = tabCost({ ...md, editing: true }, MB)
    const split = tabCost({ ...md, editing: true, split: true }, MB)
    expect(preview).toBeGreaterThan(50 * edit)
    expect(split).toBe(preview + edit)
  })

  it('Markdown acima do teto forçado não é desenhado e não conta a visualização', () => {
    const big = OPEN_LIMITS.forcedMarkdownPreviewBytes + 1
    expect(tabCost(md, big)).toBe(0)
    expect(tabCost({ ...md, editing: true, split: true }, big)).toBe(tabCost({ viewer: 'code', editing: true }, big))
  })

  it('diff e comparação têm dois editores; PDF roda em outro processo', () => {
    const code = tabCost({ viewer: 'code', editing: true }, MB)
    expect(code).toBeGreaterThan(0)
    expect(tabCost({ viewer: 'code', editing: false, diff: { path: 'a', staged: false } as never }, MB)).toBe(2 * code)
    expect(tabCost({ viewer: 'pdf', editing: false }, 10 * MB)).toBe(0)
  })
})

describe('pressureNotice', () => {
  it('diz quantas abas foram descarregadas, ou pede para fechar quando não havia nenhuma', () => {
    expect(pressureNotice(2700, 3)).toBe(
      'O Kora está usando muita memória (2,6 GB). 3 abas de arquivo inativas foram descarregadas e voltam a carregar do disco quando você abrir.'
    )
    expect(pressureNotice(2700, 1)).toContain('1 aba de arquivo inativa foi descarregada e volta')
    expect(pressureNotice(2700, 0)).toContain('Feche abas de arquivo grandes')
  })
})
