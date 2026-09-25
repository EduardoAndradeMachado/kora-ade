import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createErrorLog, errorText } from '../src/main/error-log'

const clock = (start = Date.UTC(2026, 8, 24, 21, 0, 0)) => {
  let t = start
  return () => new Date((t += 1000))
}

describe('log de erros local', () => {
  it('grava origem, mensagem e pilha; resumo conta as entradas e diz a hora da última', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-erros-'))
    const log = createErrorLog({ dir, now: clock() })
    expect(log.summary()).toEqual({ count: 0, lastAt: null })

    log.record('main', new Error('falhou ao ler o estado'))
    log.record('interface', 'mensagem solta', 'window.onerror')
    const text = readFileSync(log.file, 'utf8')
    expect(text).toMatch(/^2026-09-24T21:00:01\.000Z \[main\] Error: falhou ao ler o estado\n {4}at /)
    expect(text).toContain('2026-09-24T21:00:02.000Z [interface] window.onerror: mensagem solta')
    expect(log.summary()).toEqual({ count: 2, lastAt: '2026-09-24T21:00:02.000Z' })
  })

  it('qualquer coisa jogada vira texto legível', () => {
    expect(errorText({ codigo: 42 })).toBe('{"codigo":42}')
    expect(errorText(undefined)).toBe('undefined')
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(errorText(circular)).toBe('[object Object]')
  })

  it('passado do limite, o arquivo vira errors.old.log e o resumo continua contando os dois', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-erros-'))
    const log = createErrorLog({ dir, maxBytes: 200, now: clock() })
    for (let i = 0; i < 4; i++) log.record('main', `erro número ${i} ${'x'.repeat(60)}`)
    expect(existsSync(join(dir, 'errors.old.log'))).toBe(true)
    expect(log.summary().count).toBe(4)
    expect(log.recent(10_000)).toContain('erro número 0')
  })

  it('guarda um só arquivo antigo: o total em disco fica limitado', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-erros-'))
    const log = createErrorLog({ dir, maxBytes: 200, now: clock() })
    for (let i = 0; i < 30; i++) log.record('main', `erro número ${i} ${'x'.repeat(60)}`)
    const total = readFileSync(log.file, 'utf8').length + readFileSync(join(dir, 'errors.old.log'), 'utf8').length
    expect(total).toBeLessThan(700)
    expect(log.recent(10_000)).toContain('erro número 29')
    expect(log.recent(10_000)).not.toContain('erro número 0 ')
  })

  it('para colar: só as últimas entradas inteiras que cabem, da mais antiga para a mais nova', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-erros-'))
    const log = createErrorLog({ dir, now: clock() })
    for (let i = 0; i < 5; i++) log.record('main', `erro ${i}`)
    const recent = log.recent(120)
    expect(recent).not.toContain('erro 0')
    expect(recent.trim().split('\n').at(-1)).toContain('erro 4')
    expect(recent.length).toBeLessThanOrEqual(120)
    expect(log.recent(10)).toContain('erro 4')
  })

  it('arquivo de diagnóstico junta ambiente, erros e os outros logs (só o fim dos grandes)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-erros-'))
    const log = createErrorLog({ dir, now: clock() })
    log.record('processo', 'interface caiu: crashed')
    const lag = join(dir, 'lag.log')
    writeFileSync(lag, 'travou 500 ms\n')
    const updater = join(dir, 'updater.log')
    writeFileSync(updater, 'linha antiga\n' + 'x'.repeat(300 * 1024) + '\nlinha recente\n')
    const text = log.diagnostic({ 'Versão do Kora': '0.1.5' }, [
      { name: 'Travamentos (lag.log)', file: lag },
      { name: 'Atualização (updater.log)', file: updater },
      { name: 'Inexistente', file: join(dir, 'nao-existe.log') }
    ])
    expect(text).toContain('===== Ambiente =====\nVersão do Kora: 0.1.5')
    expect(text).toContain('[processo] interface caiu: crashed')
    expect(text).toContain('===== Travamentos (lag.log) =====\ntravou 500 ms')
    expect(text).toContain('linha recente')
    expect(text).not.toContain('linha antiga')
    expect(text).toContain('===== Inexistente =====\n(vazio)')
  })

  it('não consegue gravar (pasta inválida): segue sem lançar', () => {
    const log = createErrorLog({ dir: join(tmpdir(), 'kora-erros-\0-invalido') })
    expect(() => log.record('main', new Error('x'))).not.toThrow()
  })
})
