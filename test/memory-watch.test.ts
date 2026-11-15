import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decideMemoryWatch,
  fileSizes,
  initialWatchState,
  MEMORY_COOLDOWN_MS,
  MEMORY_STEP_MB,
  rendererMemoryMB,
  softLimitMB,
  startMemoryWatch,
  type WatchState
} from '../src/main/memory-watch'

const SOFT = 2560

// Roda uma sequência de leituras (MB, instante) e devolve em quais houve pedido de liberação.
function run(samples: [number, number][], state: WatchState = initialWatchState()): number[] {
  const released: number[] = []
  samples.forEach(([mb, at], i) => {
    const decision = decideMemoryWatch(mb, SOFT, state, at)
    state = decision.state
    if (decision.release) released.push(i)
  })
  return released
}

describe('decideMemoryWatch', () => {
  it('não pede nada abaixo do limite', () => {
    expect(run([[500, 0], [2000, 5000], [2559, 10000]])).toEqual([])
  })

  it('pede liberação na primeira leitura acima do limite', () => {
    expect(run([[2000, 0], [2600, 5000]])).toEqual([1])
  })

  it('parado acima do limite não repete o pedido, por mais tempo que passe (sem laço)', () => {
    const t = (n: number): number => n * MEMORY_COOLDOWN_MS * 2
    expect(run([[2600, t(0)], [2650, t(1)], [2700, t(2)], [2600, t(3)]])).toEqual([0])
  })

  it('pede de novo se a memória subir mais um degrau depois do intervalo mínimo', () => {
    const later = MEMORY_COOLDOWN_MS + 1
    expect(run([[2600, 0], [2600 + MEMORY_STEP_MB, later]])).toEqual([0, 1])
  })

  it('subida de um degrau dentro do intervalo mínimo espera', () => {
    expect(run([[2600, 0], [2600 + MEMORY_STEP_MB, MEMORY_COOLDOWN_MS - 1], [2600 + MEMORY_STEP_MB, MEMORY_COOLDOWN_MS + 1]])).toEqual([0, 2])
  })

  it('rearma só depois de descer abaixo do ponto de rearme', () => {
    const gap = MEMORY_COOLDOWN_MS + 1
    // Desce até logo abaixo do limite (sem rearmar) e volta: não pede.
    expect(run([[2600, 0], [2500, gap], [2600, 2 * gap]])).toEqual([0])
    // Desce bem (rearma) e volta: pede de novo.
    expect(run([[2600, 0], [1500, gap], [2600, 2 * gap]])).toEqual([0, 2])
  })
})

describe('startMemoryWatch', () => {
  afterEach(() => vi.useRealTimers())

  it('mede a cada intervalo, manda um pedido com o alvo de rearme e ignora a janela sem medida', () => {
    vi.useFakeTimers()
    const readings = [null, 1000, 3000, 3000, 3000]
    const sent: unknown[] = []
    const stop = startMemoryWatch({ usedMB: () => readings.shift() ?? 3000, send: (p) => sent.push(p) }, SOFT, 1000)
    vi.advanceTimersByTime(5000)
    stop()
    expect(sent).toEqual([{ usedMB: 3000, targetMB: Math.round(SOFT * 0.8) }])
  })
})

describe('rendererMemoryMB e softLimitMB', () => {
  it('lê a memória privada (KB) do processo da janela, ou o working set fora do Windows', () => {
    const metrics = [
      { pid: 1, memory: { privateBytes: 100 * 1024, workingSetSize: 999 } },
      { pid: 7, memory: { privateBytes: 2048 * 1024, workingSetSize: 999 } },
      { pid: 9, memory: { workingSetSize: 512 * 1024 } }
    ]
    expect(rendererMemoryMB(metrics, 7)).toBe(2048)
    expect(rendererMemoryMB(metrics, 9)).toBe(512)
    expect(rendererMemoryMB(metrics, 3)).toBeNull()
  })

  it('o limite é 2,5 GB, ou 40% da RAM numa máquina com pouca memória', () => {
    expect(softLimitMB(32 * 1024)).toBe(2560)
    expect(softLimitMB(4 * 1024)).toBe(1638)
  })
})

describe('fileSizes', () => {
  let root = ''
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }))

  it('dá o tamanho de cada arquivo e 0 para o que sumiu ou fica fora do projeto', () => {
    const base = mkdtempSync(join(tmpdir(), 'kora-memoria-'))
    root = join(base, 'projeto')
    mkdirSync(join(root, 'pasta'), { recursive: true })
    writeFileSync(join(base, 'fora.txt'), 'existe, mas fora do projeto')
    writeFileSync(join(root, 'pasta', 'a.txt'), 'x'.repeat(1234))
    writeFileSync(join(root, 'b.md'), 'abc')
    expect(fileSizes(root, ['pasta\\a.txt', 'b.md', 'sumiu.txt', '..\\fora.txt'])).toEqual([1234, 3, 0, 0])
  })
})
