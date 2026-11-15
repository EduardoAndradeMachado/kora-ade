export interface ReattachPlan {
  // Terminais vivos que a interface recarregada mostra de novo, cada um na aba de mesmo id.
  attach: string[]
  // Vivos sem aba no estado: a aba foi fechada e a interface caiu antes de pedir o encerramento. Ninguém mais os
  // veria, e um agente seguiria trabalhando (e gastando) escondido.
  orphans: string[]
}

// O pty só nasce depois de a aba entrar no estado (launchTerminal chama ensureTab antes do spawn), então pty sem
// aba no estado não é aba nova ainda não salva: é aba que deixou de existir.
export function reattachPlan(live: Iterable<string>, tabs: readonly { id: string }[]): ReattachPlan {
  const known = new Set(tabs.map((tab) => tab.id))
  const attach: string[] = []
  const orphans: string[] = []
  for (const id of live) (known.has(id) ? attach : orphans).push(id)
  return { attach, orphans }
}
