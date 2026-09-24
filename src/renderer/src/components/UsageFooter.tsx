import { useCallback, useEffect, useState } from 'react'
import type { AgentUsage } from '@shared/usage-types'
import { UsageMeter } from '@/components/UsageMeter'

const REFRESH_MS = 60_000

// O main já limita a 1 consulta por minuto por agente; aqui só pede de novo no intervalo e ao focar.
export function UsageFooter(): React.JSX.Element | null {
  const [usage, setUsage] = useState<AgentUsage[]>([])

  const refresh = useCallback(() => {
    window.kora.readUsage().then(setUsage, () => {})
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  if (usage.length === 0) return null
  return <UsageMeter usage={usage} onRefresh={refresh} />
}
