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
}
const home: MobileRoute = { projectId: null, tabId: null, picker: null }

export function useMobileNavigation(): { route: MobileRoute; navigate(route: MobileRoute): void; back(): void; replace(route: MobileRoute): void } {
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
  return { route, navigate, back, replace }
}
