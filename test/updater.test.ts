import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startUpdates, type UpdateSource } from '../src/main/updater'

afterEach(() => vi.useRealTimers())

function fakeSource(): UpdateSource & { emitter: EventEmitter; calls: string[] } {
  const emitter = new EventEmitter()
  const calls: string[] = []
  return {
    emitter,
    calls,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    checkForUpdates: async () => {
      calls.push('check')
    },
    quitAndInstall: (silent, runAfter) => {
      calls.push(`quitAndInstall(${silent}, ${runAfter})`)
    }
  } as UpdateSource & { emitter: EventEmitter; calls: string[] }
}

describe('atualização automática', () => {
  it('baixa sozinha, não instala ao sair e consulta no início e depois de tempos em tempos', () => {
    vi.useFakeTimers()
    const source = fakeSource()
    const updates = startUpdates({ source, onReady: () => {}, beforeInstall: () => {}, log: () => {}, firstCheckMs: 1000, intervalMs: 60_000 })
    expect(source.autoDownload).toBe(true)
    expect(source.autoInstallOnAppQuit).toBe(false)
    expect(source.calls).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(source.calls).toEqual(['check'])
    vi.advanceTimersByTime(120_000)
    expect(source.calls).toEqual(['check', 'check', 'check'])
    updates.stop()
  })

  it('sem versão baixada, instalar não faz nada; baixada, avisa a interface e instala silencioso reabrindo o app', () => {
    const source = fakeSource()
    const ready: string[] = []
    const order: string[] = []
    const updates = startUpdates({
      source,
      onReady: (v) => ready.push(v),
      beforeInstall: () => order.push('encerra terminais'),
      log: () => {},
      firstCheckMs: 60_000
    })
    expect(updates.install()).toBe(false)
    expect(source.calls).toEqual([])

    source.emitter.emit('update-downloaded', { version: '0.2.0' })
    expect(ready).toEqual(['0.2.0'])
    expect(updates.pending()).toBe('0.2.0')
    source.quitAndInstall = (silent, runAfter) => {
      order.push(`quitAndInstall(${silent}, ${runAfter})`)
    }
    expect(updates.install()).toBe(true)
    expect(order).toEqual(['encerra terminais', 'quitAndInstall(true, true)'])
    updates.stop()
  })

  it('erro de rede na consulta vai para o log, sem exceção solta', async () => {
    vi.useFakeTimers()
    const source = fakeSource()
    source.checkForUpdates = () => Promise.reject(new Error('sem internet'))
    const lines: string[] = []
    const updates = startUpdates({ source, onReady: () => {}, beforeInstall: () => {}, log: (l) => lines.push(l), firstCheckMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(lines).toEqual(['erro ao consultar: sem internet'])
    updates.stop()
  })
})
