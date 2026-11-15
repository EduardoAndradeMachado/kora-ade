import { useEffect, useRef, useState } from 'react'
import type { FileTab } from './file-tabs'
import { pickTabsToUnload, pressureNotice, tabCost } from './memory-tabs'

// Liberação de memória da janela: o App descarrega abas escondidas (memory-tabs escolhe quais) e o Monaco reinicia
// os workers de linguagem, quando o vigia do main pede ou antes de abrir algo pesado.

const MB = 1024 * 1024

type Releaser = (needBytes: number) => Promise<number>

let releaser: Releaser | null = null
let workerRestarter: (() => void) | null = null

// O App registra quem descarrega as abas; o módulo do Monaco, quem reinicia os workers de linguagem.
export function setTabReleaser(fn: Releaser | null): void {
  releaser = fn
}

export function setWorkerRestarter(fn: (() => void) | null): void {
  workerRestarter = fn
}

// O worker do TypeScript guarda a análise dos arquivos já fechados até ser reiniciado; reiniciar devolve isso
// e ele volta sozinho, sincronizando só as abas que ainda estão abertas.
export const restartLanguageWorkers = (): void => workerRestarter?.()

export type RoomCheck = { status: 'ok' } | { status: 'tight'; usedMB: number }

// Antes de carregar algo pesado (o "mesmo assim" dos limites): libera abas escondidas se a soma passaria do
// limite da janela; 'tight' quando nem assim cabe, para quem chamou perguntar.
export async function ensureRoom(costBytes: number): Promise<RoomCheck> {
  const usage = await window.kora.memoryUsage().catch(() => null)
  if (!usage) return { status: 'ok' }
  const need = usage.usedMB * MB + costBytes - usage.softMB * MB
  if (need <= 0) return { status: 'ok' }
  const freed = releaser ? await releaser(need).catch(() => 0) : 0
  restartLanguageWorkers()
  return need - freed <= 0 ? { status: 'ok' } : { status: 'tight', usedMB: usage.usedMB }
}

export interface OpenFileTab {
  projectId: string
  tab: FileTab
}

interface Options {
  fileTabs: readonly OpenFileTab[]
  // Abas na frente agora (a ativa do projeto selecionado).
  visibleIds: readonly string[]
  isDirty(tab: FileTab): boolean
}

// Estado das abas descarregadas para o App: quem está fora da árvore e o aviso a mostrar.
export function useTabMemory({ fileTabs, visibleIds, isDirty }: Options): {
  unloaded: ReadonlySet<string>
  notice: string | null
  dismissNotice(): void
} {
  const [unloaded, setUnloaded] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const lastShown = useRef(new Map<string, number>())
  const latest = useRef({ fileTabs, visibleIds, isDirty, unloaded })
  latest.current = { fileTabs, visibleIds, isDirty, unloaded }

  const visibleKey = visibleIds.join('\n')
  useEffect(() => {
    const now = Date.now()
    for (const id of visibleIds) lastShown.current.set(id, now)
    setUnloaded((current) => (visibleIds.some((id) => current.has(id)) ? new Set([...current].filter((id) => !visibleIds.includes(id))) : current))
    // visibleKey resume visibleIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey])

  useEffect(() => {
    const release = async (needBytes: number): Promise<{ ids: string[]; freed: number }> => {
      const { fileTabs: tabs, visibleIds: shown, isDirty: dirty, unloaded: gone } = latest.current
      const loaded = tabs.filter(({ tab }) => !gone.has(tab.id))
      const byProject = new Map<string, OpenFileTab[]>()
      for (const entry of loaded) byProject.set(entry.projectId, [...(byProject.get(entry.projectId) ?? []), entry])
      const costs = new Map<string, number>()
      await Promise.all(
        [...byProject].map(async ([projectId, entries]) => {
          const sizes = await window.kora.memoryFileSizes(projectId, entries.map((e) => e.tab.path)).catch(() => [] as number[])
          entries.forEach((e, i) => costs.set(e.tab.id, tabCost(e.tab, sizes[i] ?? 0)))
        })
      )
      const candidates = loaded.map(({ tab }) => ({
        id: tab.id,
        visible: shown.includes(tab.id),
        dirty: dirty(tab),
        lastShown: lastShown.current.get(tab.id) ?? 0,
        cost: costs.get(tab.id) ?? 0
      }))
      const ids = pickTabsToUnload(candidates, needBytes)
      // A aba pode ter ficado suja ou visível durante a consulta dos tamanhos.
      const now = latest.current
      const still = ids.filter((id) => !now.visibleIds.includes(id) && !now.fileTabs.some(({ tab }) => tab.id === id && now.isDirty(tab)))
      if (still.length) setUnloaded((current) => new Set([...current, ...still]))
      return { ids: still, freed: still.reduce((sum, id) => sum + (costs.get(id) ?? 0), 0) }
    }
    setTabReleaser(async (need) => (await release(need)).freed)
    const off = window.kora.onMemoryPressure((pressure) => {
      void release((pressure.usedMB - pressure.targetMB) * MB).then(({ ids }) => {
        restartLanguageWorkers()
        setNotice(pressureNotice(pressure.usedMB, ids.length))
      })
    })
    return () => {
      off()
      setTabReleaser(null)
    }
  }, [])

  // Aba fechada sai do conjunto (o id não volta).
  useEffect(() => {
    setUnloaded((current) => {
      if (current.size === 0) return current
      const open = new Set(fileTabs.map(({ tab }) => tab.id))
      const kept = [...current].filter((id) => open.has(id))
      return kept.length === current.size ? current : new Set(kept)
    })
  }, [fileTabs])

  return { unloaded, notice, dismissNotice: () => setNotice(null) }
}
