import { useEffect, useRef, useState } from 'react'
import type { MobileTab } from '@shared/mobile'
import { finishedUnseen } from '@/lib/alerts'
import { playChime, unlockChime } from '@/lib/chime'

// O som do celular vale só para ele, como o tema; sem escolha, fica ligado.
const SOUND_KEY = 'kora-sound'
export const savedSound = (): boolean => {
  try { return localStorage.getItem(SOUND_KEY) !== '0' } catch { return true }
}
export const saveSound = (on: boolean): void => {
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0') } catch { /* sem armazenamento, vale até fechar o app */ }
}

// Mesmo aviso do PC: a aba que parou depois de trabalhar, sem você estar olhando para ela, ganha o sininho até ser
// aberta, e a corda toca se o som estiver ligado. Só com o app aberto: com ele fechado não há quem toque.
export function useFinishedAlerts(tabs: MobileTab[] | undefined, openTabId: string | null, sound: boolean): ReadonlySet<string> {
  const [alerted, setAlerted] = useState<ReadonlySet<string>>(new Set())
  const previous = useRef(new Map<string, MobileTab['activity']>())
  const workingSince = useRef(new Map<string, number>())
  const soundRef = useRef(sound)
  soundRef.current = sound

  useEffect(() => {
    window.addEventListener('pointerdown', unlockChime, { once: true })
    return () => window.removeEventListener('pointerdown', unlockChime)
  }, [])

  useEffect(() => {
    if (!tabs) return
    const now = Date.now()
    const finished: string[] = []
    for (const tab of tabs) {
      const next = tab.live ? tab.activity : null
      const since = workingSince.current.get(tab.id) ?? null
      const watching = document.visibilityState === 'visible' && tab.id === openTabId
      if (previous.current.has(tab.id) && finishedUnseen({ previous: previous.current.get(tab.id), next, workingSince: since, now, watching })) finished.push(tab.id)
      if (next === 'working') { if (since === null) workingSince.current.set(tab.id, now) } else workingSince.current.delete(tab.id)
      previous.current.set(tab.id, next)
    }
    const byId = new Map(tabs.map((tab) => [tab.id, tab]))
    for (const id of previous.current.keys()) if (!byId.has(id)) previous.current.delete(id)
    // Some o aviso da aba fechada, suspensa ou que voltou a trabalhar.
    const stillWaiting = (id: string): boolean => { const tab = byId.get(id); return tab !== undefined && tab.live && tab.activity !== 'working' }
    setAlerted((current) => {
      const next = new Set([...[...current].filter(stillWaiting), ...finished])
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next
    })
    if (finished.length > 0 && soundRef.current) playChime()
  }, [tabs, openTabId])

  // Abrir a conversa (com o app na tela) conta como vista.
  useEffect(() => {
    if (!openTabId) return
    const clear = (): void => {
      if (document.visibilityState !== 'visible') return
      setAlerted((current) => {
        if (!current.has(openTabId)) return current
        const next = new Set(current)
        next.delete(openTabId)
        return next
      })
    }
    clear()
    document.addEventListener('visibilitychange', clear)
    return () => document.removeEventListener('visibilitychange', clear)
  }, [openTabId])

  return alerted
}
