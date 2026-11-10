import { describe, expect, it } from 'vitest'
import { createDragWatchdog, NEVER_STARTED_MS, WENT_SILENT_MS } from '../src/renderer/src/lib/drag-watchdog'

function setup() {
  let clock = 0
  let released = 0
  const watchdog = createDragWatchdog(() => released++, () => clock)
  return {
    watchdog,
    released: () => released,
    advance: (ms: number) => (clock += ms)
  }
}

describe('vigia de arrasto preso', () => {
  it('dragstart seguido de silêncio total é destravado na segunda verificação depois do prazo', () => {
    const { watchdog, released, advance } = setup()
    watchdog.event('dragstart')
    advance(NEVER_STARTED_MS - 1)
    expect(watchdog.check()).toBe(false)
    advance(2)
    expect(watchdog.check(), 'a primeira verificação vencida só marca').toBe(false)
    advance(1000)
    expect(watchdog.check()).toBe(true)
    expect(released()).toBe(1)
    for (let i = 0; i < 5; i++) {
      advance(60_000)
      watchdog.check()
    }
    expect(released(), 'destravado uma vez, o vigia para até o próximo dragstart').toBe(1)
  })

  it('arrasto que anda tem a folga longa: segurar o item parado alguns segundos não cancela', () => {
    const { watchdog, released, advance } = setup()
    watchdog.event('dragstart')
    watchdog.event('dragenter')
    for (let i = 0; i < 9; i++) {
      advance(1000)
      watchdog.check()
    }
    expect(released()).toBe(0)
    advance(WENT_SILENT_MS)
    watchdog.check()
    advance(1000)
    watchdog.check()
    expect(released(), 'parou de receber eventos de vez: era o fim que se perdeu').toBe(1)
  })

  it('evento que chega entre as duas verificações (interface presa numa tarefa longa) salva o arrasto', () => {
    const { watchdog, released, advance } = setup()
    watchdog.event('dragstart')
    advance(NEVER_STARTED_MS + 2000)
    watchdog.check()
    watchdog.event('dragover')
    advance(1000)
    watchdog.check()
    expect(released()).toBe(0)
  })

  it('arrasto que termina não é vigiado; eventos de arrasto vindos de fora do app também não', () => {
    const { watchdog, released, advance } = setup()
    watchdog.event('dragstart')
    watchdog.event('dragend')
    watchdog.event('dragenter')
    advance(60_000)
    watchdog.check()
    advance(1000)
    watchdog.check()
    expect(released()).toBe(0)
  })
})
