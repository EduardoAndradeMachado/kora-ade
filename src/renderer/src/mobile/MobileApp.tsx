import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileCommand, MobileState, MobileTab, MobileUsage, TerminalSizeEvent } from '@shared/mobile'
import type { AgentUsage } from '@shared/usage-types'
import type { SessionSummary } from '@shared/ipc'
import { Wordmark, SymbolMark } from '@/brand/Logo'
import { Icon } from '@/brand/icons'
import { api, koraApp } from './api'
import { useMobileNavigation } from './navigation'
import { FolderPicker } from './FolderPicker'
import { MobileProjectAvatar } from './MobileProjectAvatar'
import { ProjectTree, tabStatus } from './ProjectTree'
import { SessionActions } from './SessionActions'
import { NewTabSheet, TabIcon, type NewTabKind } from './NewTabSheet'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { CompactAgent } from '@/components/UsageMeter'
import { useLongPress } from './longPress'
import { PcSheet } from './PcSheet'
import { Loading } from './Loading'
import { FilesPanel } from './FilesPanel'
import { FileViewer } from './FileViewer'
import type { ThemePreference } from '@shared/state'
import type { IconName } from '@/brand/icons'
import { SessionView, type SessionFeed, type TerminalChunk } from './SessionView'

const THEMES: { theme: ThemePreference; label: string; icon: IconName }[] = [
  { theme: 'system', label: 'Sistema', icon: 'temaSistema' },
  { theme: 'light', label: 'Claro', icon: 'temaClaro' },
  { theme: 'dark', label: 'Escuro', icon: 'temaEscuro' }
]
// O tema escolhido no celular vale só para ele; sem escolha, segue o do PC.
const THEME_KEY = 'kora-theme'
const savedTheme = (): ThemePreference | null => {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return THEMES.some((option) => option.theme === value) ? value as ThemePreference : null
  } catch { return null }
}

// Tamanho provisório para abrir o processo; a tela da sessão manda o tamanho real assim que monta.
const START_SIZE = { cols: 60, rows: 30 }

export function MobileApp(): React.JSX.Element {
  const [pairCode, setPairCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('pair'))
  const [name, setName] = useState('Meu celular')
  const [state, setState] = useState<MobileState | null>(null)
  const [device, setDevice] = useState('')
  const { route, navigate, back, replace } = useMobileNavigation()
  const { projectId, tabId } = route
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [connection, setConnection] = useState(0)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [phoneTheme, setPhoneTheme] = useState(savedTheme)
  const feed = useRef<SessionFeed>({ terminal: null, size: null })
  const longPress = useLongPress()
  const selectedTab = state?.tabs.find((tab) => tab.id === tabId)
  const live = selectedTab?.live ?? false
  const refresh = useCallback(async () => {
    const result = await api<{ deviceId: string; state: MobileState }>('state')
    setDevice(result.deviceId)
    setState(result.state)
  }, [])

  useEffect(() => {
    history.replaceState(history.state, '', location.pathname)
    if (!pairCode) void refresh().catch((error) => setError(String(error.message)))
  }, [pairCode, refresh])

  // O app Android cobre a página com a logo até ela ter o que mostrar; assim a abertura não pisca telas.
  const settled = Boolean(pairCode || state || error)
  useEffect(() => { if (settled) koraApp()?.pronto() }, [settled])

  const [usage, setUsage] = useState<AgentUsage[]>([])
  const home = state !== null && !projectId
  useEffect(() => {
    if (!home || route.pc) return
    const load = (): void => { void api<MobileUsage>('usage').then((result) => setUsage(result.usage), () => {}) }
    load()
    const timer = setInterval(load, 60_000)
    return () => clearInterval(timer)
  }, [home, route.pc])

  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)')
    const theme = phoneTheme ?? state?.theme ?? 'system'
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && system.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#16171b' : '#f6f7f9')
    }
    apply()
    system.addEventListener('change', apply)
    return () => system.removeEventListener('change', apply)
  }, [state?.theme, phoneTheme])
  const theme = THEMES.find((option) => option.theme === (phoneTheme ?? state?.theme)) ?? THEMES[0]!
  const nextTheme = (): void => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!.theme
    setPhoneTheme(next)
    try { localStorage.setItem(THEME_KEY, next) } catch { /* sem armazenamento, o tema vale até fechar o app */ }
  }

  useEffect(() => {
    const focus = (): void => { if (device && !document.hidden) void refresh().catch((error) => setError(error.message)) }
    document.addEventListener('visibilitychange', focus)
    window.addEventListener('focus', focus)
    return () => { document.removeEventListener('visibilitychange', focus); window.removeEventListener('focus', focus) }
  }, [device, refresh])

  useEffect(() => {
    const update = (): void => document.documentElement.style.setProperty('--mobile-height', `${window.visualViewport?.height ?? window.innerHeight}px`)
    update()
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    return () => { window.visualViewport?.removeEventListener('resize', update); window.removeEventListener('resize', update) }
  }, [])

  useEffect(() => {
    if (!device) return
    const events = new EventSource('/api/events')
    events.onopen = () => { setConnected(true); setConnection((version) => version + 1); setError(null) }
    events.onerror = () => {
      setConnected(false)
      void refresh().catch((error) => setError(error.message))
    }
    events.addEventListener('state', (event) => setState(JSON.parse(event.data) as MobileState))
    events.addEventListener('terminal', (event) => feed.current.terminal?.(JSON.parse(event.data) as TerminalChunk))
    events.addEventListener('size', (event) => feed.current.size?.(JSON.parse(event.data) as TerminalSizeEvent))
    events.addEventListener('revoked', () => {
      events.close()
      setConnected(false)
      setDevice('')
      setState(null)
      setError('Este dispositivo foi desvinculado. Gere outro QR code no PC.')
    })
    return () => events.close()
  }, [device, refresh])

  useEffect(() => {
    setSessions([])
    if (!projectId || !device) return
    let disposed = false
    void api<SessionSummary[]>(`sessions?project=${encodeURIComponent(projectId)}`).then((sessions) => { if (!disposed) setSessions(sessions) }).catch((error) => { if (!disposed) setError(error.message) })
    return () => { disposed = true }
  }, [projectId, device, connection])

  const command = useCallback(async (command: MobileCommand): Promise<{ tabId?: string; projectId?: string }> => api('action', command), [])
  const showError = useCallback((message: string) => setError(message), [])

  const run = async (task: () => Promise<void>): Promise<void> => {
    setError(null)
    setBusy(true)
    try { await task() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const open = (id: string, project = projectId): void => navigate({ projectId: project, tabId: id, picker: null })
  const openProject = (id: string): void => navigate({ projectId: id, tabId: null, picker: null })
  const picker = (id: string | null): void => navigate({ ...route, picker: { projectId: id }, actions: undefined, newTab: undefined })
  const newTab = (id: string): void => navigate({ ...route, newTab: id })
  const tabActions = (tab: MobileTab): void => navigate({ ...route, actions: tab.id })
  const create = (project: string, kind: NewTabKind): void => {
    void run(async () => { const result = await command({ type: 'create', projectId: project, kind, ...START_SIZE }); await refresh(); if (result.tabId) replace({ projectId: project, tabId: result.tabId, picker: null }) })
  }
  const resume = (id: string): Promise<void> => run(async () => { await command({ type: 'resume', tabId: id, ...START_SIZE }); await refresh() })

  if (pairCode) return <main className="pair-screen"><div className="pair-card">
    <Wordmark height={36} />
    <h1>Conectar ao seu PC</h1>
    <p>Depois do pareamento, este navegador poderá ver e usar as sessões do Kora na mesma rede.</p>
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api('pair', { code: pairCode, name }); setPairCode(null); await refresh() }) }}>
      <label>Nome deste dispositivo<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
      <button className="primary" disabled={busy}>Vincular celular</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
  </div></main>

  if (!state && !error) return <main className="splash" aria-busy="true"><Loading label="Conectando ao PC…" size={72} /></main>

  if (!state) return <main className="pair-screen"><div className="pair-card">
    <Wordmark height={36} />
    <h1>Kora no celular</h1>
    <p>{error}</p>
    <p>No PC, abra Configurações → Celular → Nova conexão e leia o QR code.</p>
    {koraApp() && <div className="app-actions"><button className="primary" onClick={() => koraApp()!.lerQr()}>Ler QR code do PC</button><button onClick={() => koraApp()!.escolherPc()}>Procurar outro PC</button></div>}
    <button onClick={() => void run(refresh)}>Tentar novamente</button>
  </div></main>

  const project = state.projects.find((project) => project.id === projectId)
  const tabs = state.tabs.filter((tab) => tab.projectId === projectId)
  const missing = projectId ? state.missingProjectIds.includes(projectId) : false
  const actionTab = route.actions ? state.tabs.find((tab) => tab.id === route.actions) : undefined
  const saved = sessions.filter((session) => !tabs.some((tab) => tab.agent?.sessionId === session.sessionId && tab.agent.kind === session.kind))
  return <div className="mobile-app">
    <header className="mobile-header">
      <button className="home-button" aria-label="Início" onClick={() => { if (projectId) navigate({ projectId: null, tabId: null, picker: null }) }}><Wordmark height={28} /></button>
      <span role="status" className={`connection-dot ${connected ? 'online' : ''}`} aria-label={connected ? 'PC conectado' : 'Reconectando ao PC'} title={connected ? 'PC conectado' : 'Reconectando ao PC'} />
      {project ? <div className="header-title"><MobileProjectAvatar id={project.id} path={project.path} /><span>{project.name}</span></div> : <span className="header-spacer" />}
      {!projectId && <button className="icon-button" aria-label="Novo projeto" onClick={() => picker(null)} disabled={busy || !connected}><Icon name="novoProjeto" active /></button>}
    </header>
    {error && <div role="alert" className="error-banner"><Icon name="alerta" /><span>{error}</span><button className="icon-button" aria-label="Dispensar aviso" onClick={() => setError(null)}><Icon name="fechar" /></button></div>}
    {!projectId ? <><main className="project-list page-enter">
      <div className="section-heading"><div><span className="eyebrow">SEU COMPUTADOR</span><h1>Seus projetos</h1></div><span className="section-count">{state.projects.length}</span></div>
      <label className="project-search"><Icon name="buscar" /><input aria-label="Buscar projetos e abas" placeholder="Buscar projetos e abas" value={search} onChange={(event) => setSearch(event.target.value)} autoComplete="off" /></label>
      {state.projects.length === 0 ? <div className="empty-state"><SymbolMark size={56} /><h2>Seu espaço de trabalho</h2><p>Adicione uma pasta do PC para começar uma conversa.</p><button className="primary" onClick={() => picker(null)} disabled={busy || !connected}><Icon name="novoProjeto" active />Adicionar projeto</button></div> : <ProjectTree state={state} search={search} onProject={openProject} onFiles={(id) => navigate({ projectId: id, tabId: null, picker: null, files: '' })} onNewTab={newTab} onTab={(tab: MobileTab) => open(tab.id, tab.projectId)} onTabActions={tabActions} onRelocate={picker} />}
    </main>
    <footer className="mobile-footer">
      {usage.length > 0 && <button className="usage-footer" aria-label="Limites de uso e conta" onClick={() => navigate({ ...route, pc: 'usage' })}>
        {usage.map((agent) => <CompactAgent key={agent.agent} usage={agent} now={Date.now()} />)}
      </button>}
      <div className="footer-actions">
        <button className="icon-button" aria-label="Configurações" onClick={() => navigate({ ...route, pc: 'settings' })}><Icon name="engrenagem" /></button>
        <button className="theme-button" aria-label={`Tema: ${theme.label}`} onClick={nextTheme}><Icon name={theme.icon} />{theme.label}</button>
      </div>
    </footer></> : route.file !== undefined ? <FileViewer key={route.file} projectId={projectId} path={route.file} dark={document.documentElement.classList.contains('dark')} onBack={back} onOpenFile={(file) => navigate({ ...route, file })} />
    : !tabId ? <main className="session-list page-enter" key={projectId}>
      <div className="project-heading"><button className="icon-button back-button" aria-label="Voltar" onClick={back}><Icon name="expandir" className="back-icon" /></button><MobileProjectAvatar id={projectId} path={project?.path ?? ''} open /><div><h1>{project?.name ?? 'Projeto removido'}</h1><p className="project-path">{project?.path}</p></div></div>
      {missing && <div className="missing-notice"><Icon name="alerta" active /><div><strong>Pasta não encontrada</strong><p>Localize a pasta no PC para continuar usando este projeto.</p><button onClick={() => picker(projectId)}><Icon name="mover" active />Revincular pasta</button></div></div>}
      <div className="project-panels" role="tablist" aria-label="Seção do projeto">
        <button role="tab" aria-selected={route.files === undefined} onClick={() => replace({ ...route, files: undefined })}><Icon name="sessoes" />Sessões</button>
        <button role="tab" aria-selected={route.files !== undefined} disabled={missing} onClick={() => replace({ ...route, files: '' })}><Icon name="arquivo" />Arquivos</button>
      </div>
      {route.files !== undefined ? <FilesPanel projectId={projectId} dir={route.files} onDir={(dir) => navigate({ ...route, files: dir })} onFile={(file) => navigate({ ...route, file })} /> : <>
      <button className="primary new-tab-button" disabled={busy || !connected || missing} onClick={() => newTab(projectId)}><Icon name="novaAba" />Nova aba</button>
        <div className="list-heading"><h2>Abas do projeto</h2><span>{tabs.length}</span></div>
        {tabs.length === 0 && <p className="empty-copy">Nenhuma aba aberta. Inicie uma conversa acima.</p>}
        {tabs.map((tab) => <button className="session-row" key={tab.id} onClick={() => open(tab.id)} {...longPress(() => tabActions(tab))}><TabIcon tab={tab} /><span><strong>{tab.title}</strong><small>{tabStatus(tab)}</small></span><Icon name="expandir" /></button>)}
        <div className="list-heading"><h2>Conversas salvas</h2><span>{saved.length}</span></div>
        {saved.length === 0 && <p className="empty-copy">As conversas salvas neste projeto aparecem aqui.</p>}
        {saved.map((session) => <button className="session-row" disabled={busy || !connected || missing} key={`${session.kind}:${session.sessionId}`} onClick={() => void run(async () => { const result = await command({ type: 'open-session', projectId, agent: { kind: session.kind, sessionId: session.sessionId }, ...START_SIZE }); await refresh(); if (result.tabId) open(result.tabId) })}><AgentIcon kind={session.kind} /><span><strong>{session.title}</strong><small>{agentLabel(session.kind)} · {new Date(session.updatedAt).toLocaleDateString('pt-BR')}</small></span><Icon name="expandir" /></button>)}
      </>}
    </main> : !selectedTab ? <main className="session-message"><Icon name="sessoes" /><p>Esta aba foi fechada.</p><button onClick={back}>Voltar às conversas</button></main> : <>
      <div className="session-strip"><button className="icon-button back-button" aria-label="Voltar" onClick={back}><Icon name="expandir" className="back-icon" /></button><TabIcon tab={selectedTab} /><span className="session-name" title={selectedTab.title}>{selectedTab.title}</span><button className="icon-button" aria-label="Arquivos do projeto" onClick={() => navigate({ projectId, tabId: null, picker: null, files: '' })}><Icon name="projeto" /></button><button className="icon-button" aria-label="Ações da aba" onClick={() => tabActions(selectedTab)}><Icon name="ajustes" /></button></div>
      {live
        ? <SessionView key={selectedTab.id} tab={selectedTab} device={device} connected={connected} connection={connection} feed={feed} command={command} onError={showError} />
        : <main className="session-message page-enter"><div className="message-symbol"><Icon name="pausar" active /></div><h1>Sessão suspensa</h1><p className="muted">Continue para abrir o agente de novo.</p>{missing && <button onClick={() => picker(projectId)}>Revincular pasta</button>}<button className="primary" disabled={busy || !connected || missing} onClick={() => void resume(selectedTab.id)}><Icon name="retomar" active />Continuar conversa</button></main>}
    </>}
    {route.picker && <FolderPicker projectName={state.projects.find((project) => project.id === route.picker?.projectId)?.name} busy={busy} onClose={back} onSelect={async (path) => {
      setBusy(true)
      try {
        const result = await command(route.picker!.projectId ? { type: 'relocate-project', projectId: route.picker!.projectId, path } : { type: 'add-project', path })
        await refresh()
        replace(route.picker!.projectId ? { ...route, picker: null } : { projectId: result.projectId ?? null, tabId: null, picker: null })
      } finally { setBusy(false) }
    }} />}
    {route.pc && <PcSheet view={route.pc} alerts={state.alerts} connected={connected} onClose={back} onError={showError} onSwitchAccount={async (accountId) => { await command({ type: 'switch-account', accountId }) }} onAlerts={async (alerts) => { await command({ type: 'alerts', alerts }) }} />}
    {route.newTab && <NewTabSheet projectName={state.projects.find((project) => project.id === route.newTab)?.name ?? ''} busy={busy} onClose={back} onChoose={(kind) => create(route.newTab!, kind)} />}
    {actionTab && <SessionActions tab={actionTab} busy={busy} onClose={back} onRename={async (title) => run(async () => { await command({ type: 'rename', tabId: actionTab.id, title }); await refresh(); back() })} onSuspend={async () => run(async () => { await command(actionTab.live ? { type: 'suspend', tabId: actionTab.id } : { type: 'resume', tabId: actionTab.id, ...START_SIZE }); await refresh(); back() })} onDelete={async () => run(async () => { await command({ type: 'close', tabId: actionTab.id }); await refresh(); if (tabId === actionTab.id) replace({ projectId, tabId: null, picker: null }); else back() })} />}
  </div>
}
