import { useMemo } from 'react'
import { MetricsPanel, type MetricsSource } from '@/components/MetricsPanel'
import { api } from './api'
import { copyText } from './CopyActions'
import type { DayPoint, SessionMetrics } from '@shared/metrics'
import type { MobileTab } from '@shared/mobile'

// O painel de métricas do PC, com os números pedidos ao Kora do PC. A sessão vai pela aba: o celular não sabe o
// caminho do projeto no disco.
export function MetricsPage({ projectId, tab }: { projectId: string; tab: MobileTab | null }): React.JSX.Element {
  const tabId = tab?.id
  const source = useMemo<MetricsSource>(() => ({
    session: () => api<SessionMetrics>(`metrics/session?tab=${encodeURIComponent(tabId ?? '')}`),
    day: (since) => api<DayPoint[]>(`metrics/day?since=${since}`),
    copy: copyText
  }), [tabId])
  return <div className="metrics-page"><MetricsPanel projectId={projectId} agent={tab?.agent ?? null} activity={tab?.activity ?? null} source={source} /></div>
}
