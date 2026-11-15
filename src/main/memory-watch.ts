import { statSync } from 'node:fs'
import type { MemoryPressure } from '../shared/open-limits'
import { resolveInside } from './files'

// Vigia de memória da janela. A interface caiu com ~4,4 GB de memória privada (os isolates do V8 do renderer
// dividem uns 4 GB, e o worker do TypeScript sozinho chegou a 3,7 GB); passar de softMB deixa folga para um pico de
// 1 GB (um Markdown grande, uma imagem de 400 megapixels) antes de a janela cair levando os terminais.
export const MEMORY_SOFT_MB = 2560
// Máquina com pouca RAM: o Windows começa a paginar muito antes de o V8 estourar.
export const MEMORY_SOFT_RAM_FRACTION = 0.4
export const MEMORY_CHECK_MS = 5000
// Pedido de liberação de novo só se a memória subir mais isto desde o último (a liberação anterior não bastou
// ou não havia o que liberar), e nunca antes do intervalo mínimo: sem laço de pedidos com a memória parada.
export const MEMORY_STEP_MB = 512
export const MEMORY_COOLDOWN_MS = 30_000
// Rearma depois de descer abaixo disto (fração do limite).
export const MEMORY_REARM_FRACTION = 0.8

export function softLimitMB(totalRamMB: number): number {
  return Math.round(Math.min(MEMORY_SOFT_MB, totalRamMB * MEMORY_SOFT_RAM_FRACTION))
}

export interface WatchState {
  // Pode pedir assim que passar do limite (não pediu desde a última vez que desceu).
  armed: boolean
  lastRequestMB: number
  lastRequestAt: number
}

export const initialWatchState = (): WatchState => ({ armed: true, lastRequestMB: 0, lastRequestAt: -Infinity })

export interface WatchDecision {
  release: boolean
  state: WatchState
}

export function decideMemoryWatch(usedMB: number, softMB: number, state: WatchState, now: number): WatchDecision {
  if (usedMB < softMB * MEMORY_REARM_FRACTION) {
    return { release: false, state: state.armed ? state : { armed: true, lastRequestMB: 0, lastRequestAt: state.lastRequestAt } }
  }
  if (usedMB < softMB) return { release: false, state }
  const climbed = usedMB >= state.lastRequestMB + MEMORY_STEP_MB
  if (!(state.armed || climbed) || now - state.lastRequestAt < MEMORY_COOLDOWN_MS) return { release: false, state }
  return { release: true, state: { armed: false, lastRequestMB: usedMB, lastRequestAt: now } }
}

export interface MemoryProbe {
  // Memória privada do processo da janela em MB, ou null sem janela (fechada, recarregando).
  usedMB(): number | null
  send(pressure: MemoryPressure): void
}

export function startMemoryWatch(probe: MemoryProbe, softMB: number, intervalMs = MEMORY_CHECK_MS): () => void {
  let state = initialWatchState()
  const timer = setInterval(() => {
    const used = probe.usedMB()
    if (used === null) return
    const decision = decideMemoryWatch(used, softMB, state, Date.now())
    state = decision.state
    if (decision.release) probe.send({ usedMB: used, targetMB: Math.round(softMB * MEMORY_REARM_FRACTION) })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

interface ProcessMetric {
  pid: number
  memory: { privateBytes?: number; workingSetSize: number }
}

// Tamanho no disco das abas abertas, para a interface estimar quanto cada uma ocupa. Arquivo sumido ou fora do
// projeto conta 0: a aba dele não pesa o que o arquivo pesaria.
export const MAX_SIZE_QUERY = 1000

export function fileSizes(root: string, rels: readonly string[]): number[] {
  return rels.slice(0, MAX_SIZE_QUERY).map((rel) => {
    try {
      return statSync(resolveInside(root, rel)).size
    } catch {
      return 0
    }
  })
}

// app.getAppMetrics() dá KB; privateBytes só existe no Windows, nos outros fica o working set.
export function rendererMemoryMB(metrics: readonly ProcessMetric[], pid: number): number | null {
  const metric = metrics.find((m) => m.pid === pid)
  if (!metric) return null
  return Math.round((metric.memory.privateBytes ?? metric.memory.workingSetSize) / 1024)
}
