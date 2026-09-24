import { describe, expect, it } from 'vitest'
import { TerminalBus } from '../src/shared/terminal-bus'

describe('TerminalBus', () => {
  it('saída que chega antes da aba se inscrever não se perde e mantém a ordem', () => {
    const bus = new TerminalBus()
    bus.push('t1', 'PS C:\\> ')
    bus.push('t1', 'banner')

    const received: string[] = []
    bus.subscribe('t1', (d) => received.push(d))
    bus.push('t1', '!')

    expect(received).toEqual(['PS C:\\> ', 'banner', '!'])
  })

  it('saída que chega depois de fechar a aba é descartada, não acumula', () => {
    const bus = new TerminalBus()
    bus.subscribe('t1', () => {})
    bus.forget('t1')
    for (let i = 0; i < 1000; i++) bus.push('t1', 'saída do processo morrendo')
    expect(bus.pendingCount()).toBe(0)
  })

  it('aba suspensa e retomada (mesmo id) guarda a saída que chega antes da inscrição', () => {
    const bus = new TerminalBus()
    bus.subscribe('t1', () => {})
    bus.forget('t1')

    bus.expect('t1')
    bus.push('t1', 'PS C:\\projeto> claude --resume')
    const received: string[] = []
    bus.subscribe('t1', (d) => received.push(d))

    expect(received).toEqual(['PS C:\\projeto> claude --resume'])
  })

  it('saída de um terminal não vaza para outro', () => {
    const bus = new TerminalBus()
    const a: string[] = []
    bus.subscribe('a', (d) => a.push(d))
    bus.push('b', 'do b')
    bus.push('a', 'do a')
    expect(a).toEqual(['do a'])
  })
})
