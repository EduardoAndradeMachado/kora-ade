import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLagMonitor } from '../src/main/lag-monitor'

afterEach(() => vi.useRealTimers())

describe('monitor de travamento do main', () => {
  it('registra quando o laço de eventos fica preso e diz as últimas operações', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const monitor = createLagMonitor({ intervalMs: 100, thresholdMs: 300, write: (l) => lines.push(l) })
    monitor.note('ipc:terminal:spawn')
    monitor.note('detectar-sessoes')
    vi.advanceTimersByTime(1000)
    expect(lines).toEqual([])

    // Bloqueio síncrono de 800 ms: o relógio anda sem o timer rodar.
    vi.setSystemTime(Date.now() + 800)
    vi.advanceTimersByTime(100)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/main travado 800 ms; últimas operações: ipc:terminal:spawn, detectar-sessoes$/)
    monitor.stop()
  })

  it('guarda só as 8 operações mais recentes', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const monitor = createLagMonitor({ intervalMs: 100, thresholdMs: 300, write: (l) => lines.push(l) })
    for (let i = 1; i <= 10; i++) monitor.note(`op${i}`)
    vi.setSystemTime(Date.now() + 500)
    vi.advanceTimersByTime(100)
    expect(lines[0]).toMatch(/operações: op3, op4, op5, op6, op7, op8, op9, op10$/)
    monitor.stop()
  })
})
