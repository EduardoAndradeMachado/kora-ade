import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCROLLBACK_MAX_BYTES, Scrollbacks } from '../src/main/scrollback'

const dirs: string[] = []
function store(): { dir: string; scrollbacks: Scrollbacks } {
  const dir = mkdtempSync(join(tmpdir(), 'kora-scrollback-'))
  dirs.push(dir)
  return { dir, scrollbacks: new Scrollbacks(dir) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Scrollbacks', () => {
  it('grava e lê o histórico de uma aba', () => {
    const { scrollbacks } = store()
    scrollbacks.save('aba-1', 'primeira linha\nsegunda linha')
    expect(scrollbacks.load('aba-1')).toBe('primeira linha\nsegunda linha')
  })

  it('devolve null para aba sem histórico', () => {
    const { scrollbacks } = store()
    expect(scrollbacks.load('nunca-existiu')).toBeNull()
  })

  it('recusa id que sairia da pasta', () => {
    const { scrollbacks } = store()
    expect(() => scrollbacks.save('../fora', 'x')).toThrow(/ID de aba inválido/)
  })

  it('sobrescreve em vez de acumular a cada suspensão', () => {
    const { dir, scrollbacks } = store()
    scrollbacks.save('aba-1', 'antigo')
    scrollbacks.save('aba-1', 'novo')
    expect(scrollbacks.load('aba-1')).toBe('novo')
    expect(readFileSync(join(dir, 'aba-1.txt'), 'utf8')).toBe('novo')
  })

  it('corta pelo tamanho máximo mantendo o fim do histórico', () => {
    const { scrollbacks } = store()
    const count = Math.ceil(SCROLLBACK_MAX_BYTES / 20) + 1000
    const text = Array.from({ length: count }, (_, i) => `linha-${i}-${'x'.repeat(8)}`).join('\n')
    scrollbacks.save('aba-1', text)
    const saved = scrollbacks.load('aba-1')!
    expect(Buffer.byteLength(saved, 'utf8')).toBeLessThanOrEqual(SCROLLBACK_MAX_BYTES)
    expect(saved.includes(`linha-${count - 1}-`)).toBe(true)
    expect(saved).not.toContain('linha-0-')
  })

  it('apaga o histórico da aba que não existe mais e preserva o das outras', () => {
    const { dir, scrollbacks } = store()
    scrollbacks.save('viva', 'conteúdo')
    scrollbacks.save('fechada', 'conteúdo')
    scrollbacks.prune(['viva'])
    expect(scrollbacks.load('viva')).toBe('conteúdo')
    expect(scrollbacks.load('fechada')).toBeNull()
    expect(readFileSync(join(dir, 'viva.txt'), 'utf8')).toBe('conteúdo')
  })

  it('limpa sobra de gravação interrompida', () => {
    const { dir, scrollbacks } = store()
    scrollbacks.save('viva', 'conteúdo')
    writeFileSync(join(dir, 'viva.txt.tmp'), 'meio', 'utf8')
    writeFileSync(join(dir, 'outra.txt.tmp'), 'meio', 'utf8')
    scrollbacks.prune(['viva'])
    expect(() => readFileSync(join(dir, 'viva.txt.tmp'))).toThrow()
    expect(() => readFileSync(join(dir, 'outra.txt.tmp'))).toThrow()
  })

  it('prune sem pasta não falha', () => {
    const scrollbacks = new Scrollbacks(join(tmpdir(), 'kora-scrollback-nao-existe-xyz'))
    expect(() => scrollbacks.prune([])).not.toThrow()
  })
})
