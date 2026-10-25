import type { TabRef } from './ipc'

export function reconcileTabRefs(current: TabRef[], incoming: TabRef[], baseline: TabRef[]): TabRef[] {
  const known = new Map(current.map((tab) => [tab.id, tab]))
  const before = new Map(baseline.map((tab) => [tab.id, tab]))
  const seen = new Set<string>()
  const result: TabRef[] = []
  for (const tab of incoming) {
    if (seen.has(tab.id)) continue
    seen.add(tab.id)
    const previous = before.get(tab.id)
    const authoritative = known.get(tab.id)
    if (previous && !authoritative) continue
    const unchanged = previous && tab.title === previous.title && tab.titleLocked === previous.titleLocked
    result.push(unchanged && authoritative ? authoritative : tab)
  }
  for (const tab of current) if (!seen.has(tab.id) && !before.has(tab.id)) result.push(tab)
  return result
}
