import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startUpdates, type UpdateSource } from '../src/main/updater'
import type { UpdateStatus } from '../src/shared/update'

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

const quiet = { beforeInstall: () => {}, log: () => {} }

describe('atualização automática', () => {
  it('baixa sozinha, não instala ao sair e consulta no início e depois de tempos em tempos', () => {
    vi.useFakeTimers()
    const source = fakeSource()
    const updates = startUpdates({ source, onStatus: () => {}, ...quiet, firstCheckMs: 1000, intervalMs: 60_000 })
    expect(source.autoDownload).toBe(true)
    expect(source.autoInstallOnAppQuit).toBe(false)
    expect(source.calls).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(source.calls).toEqual(['check'])
    vi.advanceTimersByTime(120_000)
    expect(source.calls).toEqual(['check', 'check', 'check'])
    updates.stop()
  })

  it('estado acompanha consulta, download com porcentagem e versão pronta', () => {
    const source = fakeSource()
    const seen: UpdateStatus[] = []
    const updates = startUpdates({ source, onStatus: (s) => seen.push(s), ...quiet, firstCheckMs: 60_000 })
    expect(updates.status()).toEqual({ state: 'idle' })

    source.emitter.emit('checking-for-update')
    source.emitter.emit('update-available', { version: '0.2.0' })
    source.emitter.emit('download-progress', { percent: 41.6 })
    source.emitter.emit('update-downloaded', { version: '0.2.0' })
    expect(seen).toEqual([
      { state: 'checking' },
      { state: 'downloading', version: '0.2.0', percent: 0 },
      { state: 'downloading', version: '0.2.0', percent: 42 },
      { state: 'ready', version: '0.2.0' }
    ])
    expect(updates.status()).toEqual({ state: 'ready', version: '0.2.0' })
    updates.stop()
  })

  it('sem versão nova, fica "em dia" com a hora da consulta', () => {
    const source = fakeSource()
    const updates = startUpdates({ source, onStatus: () => {}, ...quiet, now: () => 1234, firstCheckMs: 60_000 })
    source.emitter.emit('checking-for-update')
    source.emitter.emit('update-not-available')
    expect(updates.status()).toEqual({ state: 'current', checkedAt: 1234 })
    updates.stop()
  })

  it('versão pronta não some com uma consulta nova nem com erro depois dela', () => {
    const source = fakeSource()
    const updates = startUpdates({ source, onStatus: () => {}, ...quiet, firstCheckMs: 60_000 })
    source.emitter.emit('update-downloaded', { version: '0.2.0' })
    source.emitter.emit('checking-for-update')
    source.emitter.emit('update-not-available')
    source.emitter.emit('error', new Error('sem internet'))
    expect(updates.status()).toEqual({ state: 'ready', version: '0.2.0' })
    updates.stop()
  })

  it('buscar pela tela consulta na hora, mas não dispara outra consulta enquanto uma está em andamento', () => {
    const source = fakeSource()
    const updates = startUpdates({ source, onStatus: () => {}, ...quiet, firstCheckMs: 60_000 })
    updates.check()
    expect(source.calls).toEqual(['check'])
    source.emitter.emit('checking-for-update')
    updates.check()
    source.emitter.emit('update-available', { version: '0.3.0' })
    updates.check()
    expect(source.calls).toEqual(['check'])
    updates.stop()
  })

  it('sem versão baixada, instalar não faz nada; baixada, encerra os terminais e instala silencioso reabrindo o app', () => {
    const source = fakeSource()
    const order: string[] = []
    const updates = startUpdates({ source, onStatus: () => {}, beforeInstall: () => order.push('encerra terminais'), log: () => {}, firstCheckMs: 60_000 })
    source.emitter.emit('update-available', { version: '0.2.0' })
    expect(updates.install()).toBe(false)
    expect(source.calls).toEqual([])

    source.emitter.emit('update-downloaded', { version: '0.2.0' })
    source.quitAndInstall = (silent, runAfter) => {
      order.push(`quitAndInstall(${silent}, ${runAfter})`)
    }
    expect(updates.install()).toBe(true)
    expect(order).toEqual(['encerra terminais', 'quitAndInstall(true, true)'])
    updates.stop()
  })

  it('erro de rede na consulta vai para o log e para o estado, sem exceção solta', async () => {
    vi.useFakeTimers()
    const source = fakeSource()
    source.checkForUpdates = () => Promise.reject(new Error('sem internet'))
    const lines: string[] = []
    const updates = startUpdates({ source, onStatus: () => {}, beforeInstall: () => {}, log: (l) => lines.push(l), firstCheckMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(lines).toEqual(['erro ao consultar: sem internet'])
    expect(updates.status()).toEqual({ state: 'error', message: 'sem internet' })
    updates.stop()
  })
})
