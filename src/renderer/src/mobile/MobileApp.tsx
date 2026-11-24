import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MobileCommand, MobileFilesEvent, MobileState, MobileTab, MobileUsage, TerminalSizeEvent } from '@shared/mobile'
import { publishFiles } from './file-events'
import type { AgentUsage } from '@shared/usage-types'
import type { SessionSummary } from '@shared/ipc'
import { Wordmark, SymbolMark } from '@/brand/Logo'
import { Icon } from '@/brand/icons'
import { api, koraApp, NO_CONNECTION } from './api'
import { historyMark, useMobileNavigation, type MobileRoute } from './navigation'
import { FolderPicker } from './FolderPicker'
import { MobileProjectAvatar } from './MobileProjectAvatar'
import { ProjectTree, tabStatus } from './ProjectTree'
import { CopyActions } from './CopyActions'
import { SessionActions } from './SessionActions'
import { ProjectActions } from './ProjectActions'
import { GroupActions } from './GroupActions'
import { Toaster } from './toast'
import type { EntryChange } from './FileActions'
import { NewTabSheet, TabIcon, type NewTabKind } from './NewTabSheet'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { CompactUsage } from '@/components/UsageMeter'
import { useLongPress } from './longPress'
import { PcSheet } from './PcSheet'
import { SkeletonHome, SkeletonRows } from './Skeleton'
import { FilesPanel } from './FilesPanel'
import { FileViewer, followEntry, hasEditMode } from './FileViewer'
import { FileBoundary } from './FileBoundary'
import { MetricsPage } from './MetricsPage'
import type { ThemePreference } from '@shared/state'
import type { IconName } from '@/brand/icons'
import { SessionView, type SessionFeed, type TerminalChunk } from './SessionView'
import { saveSound, savedSound, useFinishedAlerts } from './alerts'
import { useSwipe, type SwipeActions } from './swipe'
import { discardAudio } from './voice'
import type { TranscriptEvent } from '@shared/transcript'

const REOPEN_MS = 10_000

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

// Pasta em que os arquivos de cada projeto estavam: voltar a eles (da conversa, da lista ou da aba) reabre ali.
const lastFolder = new Map<string, string>()
const folderOf = (projectId: string): string => lastFolder.get(projectId) ?? ''
// Onde a lista de projetos estava ao entrar num projeto ou conversa; fechar o app volta ao topo.
let homeScroll = 0

// Tamanho provisório para abrir o processo; a tela da sessão manda o tamanho real assim que monta.
const START_SIZE = { cols: 60, rows: 30 }

// Como as conversas abrem neste aparelho: a última escolha no botão vale para todas. Sem escolha, texto.
type ChatMode = 'texto' | 'terminal'
const CHAT_MODE_KEY = 'kora-modo-conversa'
function storedChatMode(): ChatMode {
  try { return localStorage.getItem(CHAT_MODE_KEY) === 'terminal' ? 'terminal' : 'texto' } catch { return 'texto' }
}
function storeChatMode(mode: ChatMode): void {
  try { localStorage.setItem(CHAT_MODE_KEY, mode) } catch { /* sem armazenamento, a escolha dura até a página fechar */ }
}

const OPEN_CHAT_KEY = 'kora-conversa-aberta'
// Passado disso, abrir o app é começar de novo pela lista, não voltar de uma recarga.
const OPEN_CHAT_MAX_AGE_MS = 10 * 60_000
interface OpenChat { projectId: string; tabId: string; at: number }
function readOpenChat(): OpenChat | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(OPEN_CHAT_KEY) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const { projectId, tabId, at } = value as Partial<OpenChat>
    return typeof projectId === 'string' && typeof tabId === 'string' && typeof at === 'number' ? { projectId, tabId, at } : null
  } catch { return null }
}
function writeOpenChat(chat: OpenChat | null): void {
  try {
    if (chat) localStorage.setItem(OPEN_CHAT_KEY, JSON.stringify(chat))
    else localStorage.removeItem(OPEN_CHAT_KEY)
  } catch { /* sem armazenamento, a recarga volta à lista */ }
}
export function MobileApp(): React.JSX.Element {
  const [pairCode, setPairCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('pair'))
  const [name, setName] = useState('Meu celular')
  const [state, setState] = useState<MobileState | null>(null)
  const [device, setDevice] = useState('')
  const { route, navigate, back, replace, returnTo } = useMobileNavigation()
  const { projectId, tabId } = route
  useEffect(() => { if (projectId && route.files !== undefined) lastFolder.set(projectId, route.files) }, [projectId, route.files])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [connection, setConnection] = useState(0)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [phoneTheme, setPhoneTheme] = useState(savedTheme)
  const [sound, setSound] = useState(savedSound)
  const alerted = useFinishedAlerts(state?.tabs, tabId, sound)
  const feed = useRef<SessionFeed>({ terminal: null, size: null, transcript: null })
  const [chatMode, setChatMode] = useState(storedChatMode)
  // Abas levadas ao terminal sem a pessoa escolher (comando que abre seletor, pedido pendente): não mudam a preferência.
  const [sentToTerminal, setSentToTerminal] = useState<ReadonlySet<string>>(new Set())
  const chooseChatMode = (mode: ChatMode): void => {
    setChatMode(mode)
    storeChatMode(mode)
    setSentToTerminal(new Set())
  }
  const readingIn = (tab: MobileTab): boolean => Boolean(tab.agent) && chatMode === 'texto' && !sentToTerminal.has(tab.id)
  const longPress = useLongPress()
  const selectedTab = state?.tabs.find((tab) => tab.id === tabId)
  const live = selectedTab?.live ?? false
  const refresh = useCallback(async () => {
    const result = await api<{ deviceId: string; state: MobileState }>('state')
    setDevice(result.deviceId)
    setState(result.state)
  }, [])

  useEffect(() => {
    const target = window as unknown as { koraAudioPendente?: { projectId: string; tabId: string } | null }
    const restore = (): void => {
      const pending = target.koraAudioPendente
      if (!state || !pending) return
      target.koraAudioPendente = null
      if (state.tabs.some((tab) => tab.id === pending.tabId && tab.projectId === pending.projectId && tab.live)) {
        if (!history.state?.koraMobile?.depth) {
          replace({ projectId: null, tabId: null, picker: null })
          navigate({ projectId: pending.projectId, tabId: null, picker: null })
          navigate({ projectId: pending.projectId, tabId: pending.tabId, picker: null })
        } else replace({ projectId: pending.projectId, tabId: pending.tabId, picker: null })
      } else discardAudio()
    }
    window.addEventListener('kora-audio-pendente', restore)
    restore()
    return () => window.removeEventListener('kora-audio-pendente', restore)
  }, [state, replace, navigate])

  // O Android pode recarregar a página com outro app na frente (o seletor de imagem): ela voltaria à lista. A conversa
  // aberta fica marcada no aparelho, e a recarga logo depois volta para ela. Sair para a lista apaga a marca.
  const chatChecked = useRef(false)
  const loaded = state !== null
  useEffect(() => {
    if (!state || chatChecked.current) return
    chatChecked.current = true
    if ((window as { koraAudioPendente?: unknown }).koraAudioPendente || history.state?.koraMobile?.depth) return
    const saved = readOpenChat()
    if (!saved || Date.now() - saved.at > OPEN_CHAT_MAX_AGE_MS) return
    if (!state.tabs.some((tab) => tab.id === saved.tabId && tab.projectId === saved.projectId)) return
    replace({ projectId: null, tabId: null, picker: null })
    navigate({ projectId: saved.projectId, tabId: null, picker: null })
    navigate({ projectId: saved.projectId, tabId: saved.tabId, picker: null })
  }, [state, replace, navigate])
  useEffect(() => {
    if (!chatChecked.current) return
    const mark = (): void => writeOpenChat(projectId && tabId ? { projectId, tabId, at: Date.now() } : null)
    mark()
    const onHide = (): void => { if (document.hidden) mark() }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [projectId, tabId, loaded])

  useEffect(() => {
    history.replaceState(history.state, '', location.pathname)
    if (!pairCode) void refresh().catch((error) => setError(String(error.message)))
  }, [pairCode, refresh])

  // O app Android cobre a página com a logo até ela ter o que mostrar; assim a abertura não pisca telas.
  useEffect(() => { koraApp()?.pronto() }, [])

  const [usage, setUsage] = useState<AgentUsage[]>([])
  const home = state !== null && !projectId
  const projectList = useRef<HTMLElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { if (home && projectList.current) projectList.current.scrollTop = homeScroll }, [home])
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
  const chooseTheme = (next: ThemePreference): void => {
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
    // O teclado encolhe a área visível; a pinça também, mas só por ampliar: vezes a escala, o app não encolhe com o zoom.
    const update = (): void => {
      const viewport = window.visualViewport
      document.documentElement.style.setProperty('--mobile-height', `${viewport ? viewport.height * viewport.scale : window.innerHeight}px`)
    }
    update()
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    return () => { window.visualViewport?.removeEventListener('resize', update); window.removeEventListener('resize', update) }
  }, [])

  // Tentar de novo do aviso de sem conexão: abre de novo o fluxo de eventos, e a volta dele recarrega o que está aberto.
  const [attempt, setAttempt] = useState(0)
  const retry = (): void => {
    setError(null)
    setAttempt((value) => value + 1)
  }
  useEffect(() => {
    if (!device) return
    const events = new EventSource('/api/events')
    let reopen: ReturnType<typeof setTimeout> | undefined
    events.onopen = () => { setConnected(true); setConnection((version) => version + 1); setError(null) }
    events.onerror = () => {
      setConnected(false)
      void refresh().catch((error) => setError(error.message))
      // Resposta que não é o fluxo (o 502 da passagem quando o relay não alcança o PC) faz o EventSource desistir de
      // vez, sem tentar mais sozinho: a tela tenta de novo aqui.
      if (events.readyState === EventSource.CLOSED) reopen = setTimeout(() => setAttempt((value) => value + 1), REOPEN_MS)
    }
    events.addEventListener('state', (event) => setState(JSON.parse(event.data) as MobileState))
    events.addEventListener('terminal', (event) => feed.current.terminal?.(JSON.parse(event.data) as TerminalChunk))
    events.addEventListener('size', (event) => feed.current.size?.(JSON.parse(event.data) as TerminalSizeEvent))
    events.addEventListener('files', (event) => publishFiles(JSON.parse(event.data) as MobileFilesEvent))
    events.addEventListener('transcript', (event) => feed.current.transcript?.(JSON.parse(event.data) as TranscriptEvent))
    events.addEventListener('revoked', () => {
      events.close()
      setConnected(false)
      setDevice('')
      setState(null)
      setError('Este dispositivo foi desvinculado. Gere outro QR code no PC.')
    })
    return () => {
      events.close()
      clearTimeout(reopen)
    }
  }, [device, refresh, attempt])

  useEffect(() => {
    setSessions([])
    if (!projectId || !device) return
    let disposed = false
    setSessionsLoading(true)
    void api<SessionSummary[]>(`sessions?project=${encodeURIComponent(projectId)}`).then((sessions) => { if (!disposed) setSessions(sessions) }).catch((error) => { if (!disposed) setError(error.message) }).finally(() => { if (!disposed) setSessionsLoading(false) })
    return () => { disposed = true }
  }, [projectId, device, connection])

  const command = useCallback(async (command: MobileCommand): Promise<{ tabId?: string; projectId?: string; groupId?: string }> => api('action', command), [])
  // As folhas de organização mostram o erro nelas mesmas: aqui só manda e traz o estado novo.
  const act = async (next: MobileCommand): Promise<{ groupId?: string }> => {
    const result = await command(next)
    await refresh()
    return result
  }
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
  // A folha mostra a falha (sem conexão, pasta sumida) e continua aberta; só sai quando a aba existe no PC.
  const create = async (project: string, kind: NewTabKind): Promise<void> => {
    const result = await command({ type: 'create', projectId: project, kind, ...START_SIZE })
    await refresh()
    if (result.tabId) replace({ projectId: project, tabId: result.tabId, picker: null })
  }
  // Fecha a folha (volta no histórico) e, já na tela de baixo, ajusta a rota: trocar antes deixaria a entrada velha no histórico.
  const afterBack = (next: (current: MobileRoute) => void): void => {
    window.addEventListener('popstate', () => { const current = history.state?.koraMobile?.route as MobileRoute | undefined; if (current) next(current) }, { once: true })
    back()
  }
  const under = (path: string, parent: string): boolean => { const a = path.replace(/\\/g, '/').toLowerCase(); const b = parent.replace(/\\/g, '/').toLowerCase(); return a === b || a.startsWith(`${b}/`) }
  // Item renomeado, movido ou apagado pelo celular: o rascunho, a pasta lembrada e o arquivo aberto acompanham.
  const entryChanged = (change: EntryChange, fromViewer: boolean): void => {
    if (!projectId || change.kind === 'created') return
    const from = change.kind === 'moved' ? change.from : change.path
    const to = change.kind === 'moved' ? change.to : null
    followEntry(projectId, from, to)
    const folder = lastFolder.get(projectId)
    if (folder !== undefined && under(folder, from)) lastFolder.delete(projectId)
    if (!fromViewer) return
    afterBack((current) => {
      if (current.file === undefined || !under(current.file, from)) return
      if (to === null) back()
      else replace({ ...current, file: to + current.file.slice(from.length) })
    })
  }
  const resume = (id: string): Promise<void> => run(async () => { await command({ type: 'resume', tabId: id, ...START_SIZE }); await refresh() })
  const chat = route.chat
  const toChat = chat && state?.tabs.some((tab) => tab.id === chat.tabId) ? () => returnTo(chat) : undefined
  const chatFiles = (chatTab: string): void => { if (projectId) navigate({ projectId, tabId: null, picker: null, files: folderOf(projectId), chat: { tabId: chatTab, ...historyMark() } }) }
  // Os mesmos caminhos dos botões da faixa: voltar, arquivos do projeto e voltar à conversa. Com folha aberta, nada.
  const sheetOpen = Boolean(route.picker || route.pc || route.newTab || route.actions || route.projectActions || route.groupActions || route.rename || route.menu || route.fileOptions)
  const swipe: SwipeActions = !projectId || sheetOpen ? {}
    : route.file !== undefined || !tabId ? { right: toChat }
    : selectedTab ? { left: () => chatFiles(selectedTab.id), right: back } : {}
  const [appElement, setAppElement] = useState<HTMLDivElement | null>(null)
  useSwipe(appElement, swipe)

  if (pairCode) return <main className="pair-screen"><div className="pair-card">
    <Wordmark height={36} />
    <h1>Conectar ao seu PC</h1>
    <p>Depois do pareamento, este navegador poderá ver e usar as sessões do Kora na mesma rede.</p>
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api('pair', { code: pairCode, name, certificado: koraApp()?.certificado?.() || undefined }); setPairCode(null); await refresh() }) }}>
      <label>Nome deste dispositivo<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
      <button className="primary" disabled={busy}>Vincular celular</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
  </div></main>

  if (!state && !error) return <SkeletonHome />

  if (!state) return <main className="pair-screen"><div className="pair-card">
    <Wordmark height={36} />
    <h1>Kora no celular</h1>
    <p>{error}</p>
    <p>No PC, abra Configurações → Celular → Nova conexão e leia o QR code.</p>
    {koraApp()
      ? <div className="app-actions"><button className="primary" onClick={() => koraApp()!.lerQr()}>Ler QR code do PC</button><button onClick={() => koraApp()!.escolherPc()}>Trocar de PC</button></div>
      : <button onClick={() => void run(refresh)}>Tentar novamente</button>}
  </div></main>

  const project = state.projects.find((project) => project.id === projectId)
  const tabs = state.tabs.filter((tab) => tab.projectId === projectId)
  const missing = projectId ? state.missingProjectIds.includes(projectId) : false
  const actionProject = state.projects.find((project) => project.id === route.projectActions)
  const actionGroup = route.groupActions?.id ? state.groups.find((group) => group.id === route.groupActions!.id) : undefined
  const actionTab = state.tabs.find((tab) => tab.id === (route.actions ?? route.rename))
  const saved = sessions.filter((session) => !tabs.some((tab) => tab.agent?.sessionId === session.sessionId && tab.agent.kind === session.kind))
  // Dentro da conversa a barra da sessão já tem o voltar: o cabeçalho com o logo sai e a altura vai para a conversa.
  const inChat = Boolean(projectId && route.file === undefined && tabId && selectedTab)
  return <div className={`mobile-app ${projectId ? 'inside-project' : ''} ${inChat ? 'in-chat' : ''}`} ref={setAppElement}>
    <header className="mobile-header">
      <button className="home-button" aria-label="Início" onClick={() => { if (projectId) navigate({ projectId: null, tabId: null, picker: null }) }}><Wordmark height={28} /></button>
      <span role="status" className={`connection-dot ${connected ? 'online' : ''}`} aria-label={connected ? 'PC conectado' : 'Reconectando ao PC'} title={connected ? 'PC conectado' : 'Reconectando ao PC'} />
      {project ? <div className="header-title"><MobileProjectAvatar id={project.id} path={project.path} /><span>{project.name}</span></div> : <span className="header-spacer" />}
      {!projectId && state.projects.length > 0 && <button className="icon-button" aria-label="Buscar projetos" onClick={() => { projectList.current?.scrollTo({ top: 0 }); searchField.current?.focus() }}><Icon name="buscar" /></button>}
      {!projectId && <button className="icon-button" aria-label="Novo projeto" onClick={() => picker(null)} disabled={busy || !connected}><Icon name="novoProjeto" active /></button>}
    </header>
    {error && <div role="alert" className="error-banner"><Icon name="alerta" /><span>{error}</span>{error === NO_CONNECTION && <button className="retry-button" onClick={retry}><Icon name="atualizar" />Tentar de novo</button>}<button className="icon-button" aria-label="Dispensar aviso" onClick={() => setError(null)}><Icon name="fechar" /></button></div>}
    {!projectId ? <><main className="project-list page-enter" ref={projectList} onScroll={(event) => { homeScroll = event.currentTarget.scrollTop }}>
      <div className="section-heading"><div><span className="eyebrow">SEU COMPUTADOR</span><h1>Seus projetos</h1></div><div className="section-actions"><span className="section-count">{state.projects.length}</span><button className="icon-button" aria-label="Nova categoria" disabled={!connected} onClick={() => navigate({ ...route, groupActions: { id: null } })}><Icon name="novaCategoria" /></button></div></div>
      <label className="project-search"><Icon name="buscar" /><input ref={searchField} type="search" aria-label="Buscar projetos, abas e categorias" placeholder="Buscar projeto, aba ou categoria" value={search} onChange={(event) => setSearch(event.target.value)} autoComplete="off" /></label>
      {state.projects.length === 0 ? <div className="empty-state"><SymbolMark size={56} /><h2>Seu espaço de trabalho</h2><p>Adicione uma pasta do PC para começar uma conversa.</p><button className="primary" onClick={() => picker(null)} disabled={busy || !connected}><Icon name="novoProjeto" active />Adicionar projeto</button></div> : <ProjectTree state={state} alerted={alerted} search={search} onProject={openProject} onFiles={(id) => navigate({ projectId: id, tabId: null, picker: null, files: folderOf(id) })} onNewTab={newTab} onTab={(tab: MobileTab) => open(tab.id, tab.projectId)} onTabActions={tabActions} onProjectActions={(id) => navigate({ ...route, projectActions: id })} onRelocate={picker} onGroupActions={(id) => navigate({ ...route, groupActions: { id } })} />}
    </main>
    {/* Uma linha só: os limites ocupam o espaço e a engrenagem fica ao lado; o tema mora nas configurações. */}
    <footer className="mobile-footer">
      {usage.length > 0 && <button className="usage-footer" aria-label="Limites de uso e conta" onClick={() => navigate({ ...route, pc: 'usage' })} {...longPress(() => navigate({ ...route, pc: 'usage' }))}>
        <CompactUsage usage={usage} now={Date.now()} />
      </button>}
      <button className="icon-button footer-settings" aria-label="Configurações" onClick={() => navigate({ ...route, pc: 'settings' })}><Icon name="engrenagem" /></button>
    </footer></> : route.file !== undefined ? <FileBoundary key={route.file} path={route.file} canEdit={hasEditMode(route.file)} onBack={back}>{(startInEdit) => <FileViewer actions={Boolean(route.fileOptions)} onActions={(open) => open ? navigate({ ...route, fileOptions: { path: route.file!, name: route.file!.split(/[\\/]/).pop() ?? route.file!, isDir: false } }) : back()} projectId={projectId} path={route.file!} startInEdit={startInEdit} dark={document.documentElement.classList.contains('dark')} connection={connection} line={route.fileLine ?? null} onBack={back} onChat={toChat} onOpenFile={(file) => navigate({ ...route, file, fileLine: undefined })} onEntryChanged={(change) => entryChanged(change, true)} />}</FileBoundary>
    : !tabId ? <main className="session-list page-enter" key={projectId}>
      <div className="project-heading"><button className="icon-button back-button" aria-label="Voltar" onClick={back}><Icon name="expandir" className="back-icon" /></button><MobileProjectAvatar id={projectId} path={project?.path ?? ''} open /><div><h1>{project?.name ?? 'Projeto removido'}</h1></div>{toChat && <button className="icon-button chat-return" aria-label="Voltar à conversa" onClick={toChat}><Icon name="conversa" active /></button>}</div>
      {missing && <div className="missing-notice"><Icon name="alerta" active /><div><strong>Pasta não encontrada</strong><p>Localize a pasta no PC para continuar usando este projeto.</p><button onClick={() => picker(projectId)}><Icon name="mover" active />Revincular pasta</button></div></div>}
      <div className="project-panels" role="tablist" aria-label="Seção do projeto">
        <button role="tab" aria-selected={route.files === undefined && !route.metrics} onClick={() => replace({ ...route, files: undefined, metrics: undefined })}><Icon name="sessoes" active={route.files === undefined && !route.metrics} />Sessões</button>
        <button role="tab" aria-selected={route.files !== undefined} disabled={missing} onClick={() => replace({ ...route, files: folderOf(projectId), metrics: undefined })}><Icon name="arquivo" active={route.files !== undefined} />Arquivos</button>
        <button role="tab" className="panel-icon" aria-label="Métricas" aria-selected={Boolean(route.metrics)} onClick={() => replace({ ...route, files: undefined, metrics: { tabId: route.chat?.tabId ?? null } })}><Icon name="metricas" active={Boolean(route.metrics)} /></button>
      </div>
      {route.metrics ? <MetricsPage projectId={projectId} tab={tabs.find((tab) => tab.id === route.metrics!.tabId && tab.agent) ?? tabs.find((tab) => tab.agent) ?? null} /> : route.files !== undefined ? <FilesPanel selected={route.fileOptions ?? null} onSelect={(entry) => entry ? navigate({ ...route, fileOptions: entry }) : back()} projectId={projectId} dir={route.files} connection={connection} onChanged={(change) => entryChanged(change, false)} onFailed={() => { if (lastFolder.get(projectId) === route.files) lastFolder.delete(projectId) }} onDir={(dir) => navigate({ ...route, files: dir })} onFile={(file) => navigate({ ...route, file })} /> : <>
      <button className="primary new-tab-button" disabled={busy || !connected || missing} onClick={() => newTab(projectId)}><Icon name="novaAba" />Nova aba</button>
        <div className="list-heading"><h2>Abas do projeto</h2><span>{tabs.length}</span></div>
        {tabs.length === 0 && <p className="empty-copy">Nenhuma aba aberta. Inicie uma conversa acima.</p>}
        {tabs.map((tab) => <button className="session-row" key={tab.id} onClick={() => open(tab.id)} {...longPress(() => tabActions(tab))}><TabIcon tab={tab} alert={alerted.has(tab.id)} /><span><strong>{tab.title}</strong><small>{tabStatus(tab, alerted.has(tab.id))}</small></span><Icon name="expandir" /></button>)}
        <div className="list-heading"><h2>Conversas salvas</h2><span>{saved.length}</span></div>
        {sessionsLoading && <SkeletonRows label="Carregando as conversas salvas" row="session-row" count={2} detail />}
        {!sessionsLoading && saved.length === 0 && <p className="empty-copy">As conversas salvas neste projeto aparecem aqui.</p>}
        {saved.map((session) => <button className="session-row" disabled={busy || !connected || missing} key={`${session.kind}:${session.sessionId}`} {...longPress(() => navigate({ ...route, menu: { title: session.title, values: [{ label: 'Copiar ID da sessão', text: session.sessionId }] } }))} onClick={() => void run(async () => { const result = await command({ type: 'open-session', projectId, agent: { kind: session.kind, sessionId: session.sessionId }, ...START_SIZE }); await refresh(); if (result.tabId) open(result.tabId) })}><AgentIcon kind={session.kind} /><span><strong>{session.title}</strong><small>{agentLabel(session.kind)} · {new Date(session.updatedAt).toLocaleDateString('pt-BR')}</small></span><Icon name="expandir" /></button>)}
      </>}
    </main> : !selectedTab ? <main className="session-message"><Icon name="sessoes" /><p>Esta aba foi fechada.</p><button onClick={back}>Voltar às conversas</button></main> : <>
      <div className="session-strip"><button className="icon-button back-button" aria-label="Voltar" onClick={back}><Icon name="expandir" className="back-icon" /></button><span role="status" className={`connection-dot ${connected ? 'online' : ''}`} aria-label={connected ? 'PC conectado' : 'Reconectando ao PC'} title={connected ? 'PC conectado' : 'Reconectando ao PC'} /><TabIcon tab={selectedTab} /><button className="session-name" aria-label={`Renomear ${selectedTab.title}`} onClick={() => navigate({ ...route, rename: selectedTab.id })} {...longPress(() => tabActions(selectedTab))}><span>{selectedTab.title}</span><Icon name="editar" /></button>{live && selectedTab.agent && <button className={`icon-button reading-toggle ${readingIn(selectedTab) ? 'on' : ''}`} aria-label={readingIn(selectedTab) ? 'Mostrar o terminal' : 'Mostrar como texto'} aria-pressed={readingIn(selectedTab)} onClick={() => chooseChatMode(readingIn(selectedTab) ? 'terminal' : 'texto')}><Icon name={readingIn(selectedTab) ? 'conversa' : 'terminal'} active={readingIn(selectedTab)} /></button>}<button className="icon-button" aria-label="Arquivos do projeto" onClick={() => chatFiles(selectedTab.id)}><Icon name="projeto" /></button></div>
      {live
        ? <SessionView key={selectedTab.id} tab={selectedTab} device={device} connected={connected} connection={connection} feed={feed} command={command} onError={showError} onOpenFile={(file, line) => navigate({ projectId, tabId: null, picker: null, file, ...(line ? { fileLine: line } : {}), chat: { tabId: selectedTab.id, ...historyMark() } })} dictation={state.dictation} reading={readingIn(selectedTab)} onTerminal={() => setSentToTerminal((current) => new Set(current).add(selectedTab.id))} modelSheet={route.modelSheet === selectedTab.id} onModelSheet={(open) => { if (open) navigate({ ...route, modelSheet: selectedTab.id }); else if (route.modelSheet) back() }} />
        : <main className="session-message page-enter"><div className="message-symbol"><Icon name="pausar" active /></div><h1>{selectedTab.agent ? 'Sessão suspensa' : 'Terminal encerrado'}</h1><p className="muted">{selectedTab.agent ? 'Continue para abrir o agente de novo.' : 'Abra para começar um terminal novo nesta pasta.'}</p>{missing && <button onClick={() => picker(projectId)}>Revincular pasta</button>}<button className="primary" disabled={busy || !connected || missing} onClick={() => void resume(selectedTab.id)}><Icon name="retomar" active />{selectedTab.agent ? 'Continuar conversa' : 'Abrir terminal'}</button></main>}
    </>}
    {route.picker && <FolderPicker projectName={state.projects.find((project) => project.id === route.picker?.projectId)?.name} busy={busy} onClose={back} onSelect={async (path) => {
      setBusy(true)
      try {
        const result = await command(route.picker!.projectId ? { type: 'relocate-project', projectId: route.picker!.projectId, path } : { type: 'add-project', path })
        await refresh()
        replace(route.picker!.projectId ? { ...route, picker: null } : { projectId: result.projectId ?? null, tabId: null, picker: null })
      } finally { setBusy(false) }
    }} />}
    {route.menu && <CopyActions menu={route.menu} onClose={back} />}
    {actionProject && <ProjectActions project={actionProject} state={state} onClose={back} act={act} onRemoved={() => afterBack((current) => { if (current.projectId === actionProject.id) replace({ projectId: null, tabId: null, picker: null }) })} />}
    {route.groupActions && (route.groupActions.id === null || actionGroup) && <GroupActions group={actionGroup ?? null} state={state} onClose={back} act={act} />}
    {route.pc && <PcSheet view={route.pc} themes={THEMES} theme={phoneTheme ?? state.theme} onTheme={chooseTheme} alerts={state.alerts} sound={sound} onSound={(on) => { setSound(on); saveSound(on) }} connected={connected} onClose={back} onError={showError} onSwitchAccount={async (accountId) => { await command({ type: 'switch-account', accountId }) }} onAlerts={async (alerts) => { await command({ type: 'alerts', alerts }) }} />}
    {route.newTab && <NewTabSheet projectName={state.projects.find((project) => project.id === route.newTab)?.name ?? ''} busy={busy} onClose={back} connected={connected} onChoose={(kind) => create(route.newTab!, kind)} />}
    {actionTab && <SessionActions tab={actionTab} busy={busy} onMetrics={() => replace({ projectId: actionTab.projectId, tabId: null, picker: null, metrics: { tabId: actionTab.id } })} renameOnly={!route.actions} onClose={back} onRename={async (title) => run(async () => { await command({ type: 'rename', tabId: actionTab.id, title }); await refresh(); back() })} onSuspend={async () => run(async () => { await command(actionTab.live ? { type: 'suspend', tabId: actionTab.id } : { type: 'resume', tabId: actionTab.id, ...START_SIZE }); await refresh(); back() })} onDelete={async () => run(async () => { await command({ type: 'close', tabId: actionTab.id }); await refresh(); if (tabId === actionTab.id) replace({ projectId, tabId: null, picker: null }); else back() })} />}
    <Toaster />
  </div>
}
