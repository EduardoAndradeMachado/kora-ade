import { useCallback, useEffect, useState } from 'react'

export interface MobileRoute {
  projectId: string | null
  tabId: string | null
  picker: { projectId: string | null } | null
  // Folhas abertas por cima da tela: o voltar do celular fecha a folha antes de sair da tela.
  newTab?: string
  actions?: string
  pc?: 'usage' | 'settings'
  // Arquivos do projeto: files é a pasta aberta ('' é a raiz); file, o arquivo aberto por cima dela.
  files?: string
  file?: string
  // Arquivos abertos de dentro de uma conversa: a entrada dela no histórico, para voltar pulando as pastas.
  chat?: { tabId: string } & HistoryMark
}
// key é a da Navigation API, que conhece só as entradas desta página: link tocado dentro da prévia HTML (iframe) também
// entra no histórico do navegador, e contar por depth pararia antes da conversa. depth fica para quem não tem a API.
export interface HistoryMark { depth: number; key?: string }
interface NavigationApi { currentEntry: { key: string } | null; entries(): { key: string }[]; traverseTo(key: string): { finished: Promise<unknown> } }
const navigationApi = (): NavigationApi | undefined => (window as unknown as { navigation?: NavigationApi }).navigation
const home: MobileRoute = { projectId: null, tabId: null, picker: null }
const historyDepth = (): number => history.state?.koraMobile?.depth ?? 0
export const historyMark = (): HistoryMark => ({ depth: historyDepth(), key: navigationApi()?.currentEntry?.key })

export function useMobileNavigation(): { route: MobileRoute; navigate(route: MobileRoute): void; back(): void; replace(route: MobileRoute): void; returnTo(mark: HistoryMark): void } {
  const [route, setRoute] = useState<MobileRoute>(() => history.state?.koraMobile?.route ?? home)
  useEffect(() => {
    if (!history.state?.koraMobile) history.replaceState({ koraMobile: { route: home, depth: 0 } }, '', location.pathname)
    const pop = (): void => setRoute(history.state?.koraMobile?.route ?? home)
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  const navigate = useCallback((route: MobileRoute): void => {
    if (JSON.stringify(history.state?.koraMobile?.route) === JSON.stringify(route)) return
    history.pushState({ koraMobile: { route, depth: (history.state?.koraMobile?.depth ?? 0) + 1 } }, '', location.pathname)
    setRoute(route)
  }, [])
  const replace = useCallback((route: MobileRoute): void => {
    history.replaceState({ koraMobile: { route, depth: history.state?.koraMobile?.depth ?? 0 } }, '', location.pathname)
    setRoute(route)
  }, [])
  const back = useCallback((): void => {
    if (history.state?.koraMobile?.depth > 0) history.back()
    else { history.replaceState({ koraMobile: { route: home, depth: 0 } }, '', location.pathname); setRoute(home) }
  }, [])
  const returnTo = useCallback((mark: HistoryMark): void => {
    const navigation = navigationApi()
    if (mark.key && navigation?.entries().some((entry) => entry.key === mark.key)) {
      navigation.traverseTo(mark.key).finished.catch(() => {})
      return
    }
    const steps = mark.depth - historyDepth()
    if (steps < 0) history.go(steps)
  }, [])
  return { route, navigate, back, replace, returnTo }
}
