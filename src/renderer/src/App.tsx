import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { FILE_FONT, GROUP_NAME_MAX, stepValue, TERMINAL_FONT, ZOOM, type KoraState, type Project, type ProjectGroup } from '@shared/state'
import type { AgentSession } from '@shared/agent'
import { viewerFor } from '@shared/file-kind'
import { arrangeProjects, reorder, sortBySection, type Place, type ProjectDrop } from '@shared/arrange'
import { moveAmongSiblings, nestGroup, placeGroup, removeGroup, setGroupHidden } from '@shared/groups'
import type { CloseKind, ErrorSummary, Launch, SessionSummary, TabRef } from '@shared/ipc'
import { Sidebar, type GroupAction } from '@/components/Sidebar'
import { TabBar, type Tab } from '@/components/TabBar'
import { TerminalView } from '@/components/TerminalView'
import { RightPanel } from '@/components/RightPanel'
import { MarkdownView } from '@/components/MarkdownView'
import { PdfView } from '@/components/PdfView'
import { ImageView } from '@/components/ImageView'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ModeToggle } from '@/components/ModeToggle'
import { useZoomShortcuts } from '@/lib/use-zoom-shortcuts'
import { useCloseTabShortcut } from '@/lib/use-close-tab-shortcut'
import { useRenameTabShortcut } from '@/lib/use-rename-tab-shortcut'
import { Button } from '@/brand/Button'
import { SymbolMark } from '@/brand/Logo'
import { OrphanDialog, type OrphanSurvivor } from '@/components/OrphanDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { playChime } from '@/lib/chime'
import { copyPath } from '@/lib/copied-path'
import { finishedUnseen } from '@/lib/alerts'
import { agentLabel } from '@/components/AgentIcon'
import type { UpdateStatus } from '@shared/update'

// O Monaco pesa vários MB e a primeira abertura levava ~1,6 s; fora do caminho do boot, mas pré-carregado
// quando o app fica ocioso, para o primeiro clique num arquivo já encontrar o editor pronto.
const loadCodeView = () => import('@/components/CodeView').then((m) => ({ default: m.CodeView }))
const CodeView = lazy(loadCodeView)
const MONACO_PRELOAD_DELAY_MS = 3000
import { DormantView } from '@/components/DormantView'
import { useChoose, useConfirm } from '@/components/ConfirmDialog'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import type { RenameRequest, TabPlace } from '@/components/TabBar'
import type { NewTabChoice } from '@/components/NewTabMenu'
import { terminalBus } from '@/lib/terminal-bus'

type TabsByProject = Record<string, Tab[]>

type Sizes = { zoom: number; terminalFontSize: number; fileFontSize: number }
const SIZE_RANGES: Record<keyof Sizes, typeof ZOOM> = { zoom: ZOOM, terminalFontSize: TERMINAL_FONT, fileFontSize: FILE_FONT }
const DEFAULT_SIZES: Sizes = { zoom: ZOOM.default, terminalFontSize: TERMINAL_FONT.default, fileFontSize: FILE_FONT.default }
const SIZE_LABELS: Record<Exclude<keyof Sizes, 'zoom'>, string> = { terminalFontSize: 'Terminal', fileFontSize: 'Arquivos' }

const RIGHT_PANEL_KEY = 'kora.rightPanelOpen'
const DEFAULT_TITLE: Record<NewTabChoice, string> = {
  shell: 'Terminal',
  claude: 'Claude',
  codex: 'Codex',
  existing: 'Sessão fixada'
}

function initialRightPanel(): boolean {
  try {
    const saved = localStorage.getItem(RIGHT_PANEL_KEY)
    if (saved !== null) return saved === '1'
  } catch {
    // localStorage indisponível: cai no padrão pela largura da janela.
  }
  return window.innerWidth >= 1100
}

function restoreTabs(state: KoraState): TabsByProject {
  const byProject: TabsByProject = {}
  for (const saved of state.tabs) {
    const tab: Tab = {
      kind: 'terminal',
      id: saved.id,
      title: saved.title,
      titleLocked: saved.titleLocked,
      live: false,
      agent: saved.agent
    }
    ;(byProject[saved.projectId] ??= []).push(tab)
  }
  return byProject
}

function tabRefs(tabs: TabsByProject): TabRef[] {
  return Object.entries(tabs).flatMap(([projectId, list]) =>
    list.flatMap((t) =>
      t.kind === 'terminal' ? [{ id: t.id, projectId, title: t.title, titleLocked: t.titleLocked }] : []
    )
  )
}

const isUnder = (path: string, rel: string): boolean =>
  path === rel || path.startsWith(`${rel}\\`) || path.startsWith(`${rel}/`)

export function App(): React.JSX.Element {
  const [state, setState] = useState<KoraState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<TabsByProject>({})
  const [activeTab, setActiveTab] = useState<Record<string, string | undefined>>({})
  const [rightPanelOpen, setRightPanelOpen] = useState(initialRightPanel)
  const [error, setError] = useState<string | null>(null)
  const [tabMenu, setTabMenu] = useState<{ projectId: string; tabId: string; where: TabPlace; x: number; y: number } | null>(null)
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null)
  const confirm = useConfirm()
  const choose = useChoose()
  const fileSavers = useRef(new Map<string, () => Promise<boolean>>())
  // Fonte da verdade do "não salvo", atualizada na hora da edição. O estado das abas só muda no próximo desenho:
  // Ctrl+W logo depois de digitar via a aba ainda limpa e fechava sem perguntar, perdendo a edição.
  const dirtyFiles = useRef(new Set<string>())
  const isDirty = (tab: Tab): boolean => tab.kind === 'file' && (tab.dirty || dirtyFiles.current.has(tab.id))
  const [toast, setToast] = useState<string | null>(null)
  const [orphans, setOrphans] = useState<OrphanSurvivor[]>([])
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const [errorSummary, setErrorSummary] = useState<ErrorSummary | null>(null)
  useEffect(() => {
    if (!settingsOpen) return
    setErrorSummary(null)
    window.kora.errorSummary().then(setErrorSummary, () => setErrorSummary({ count: 0, lastAt: null }))
  }, [settingsOpen])

  useEffect(() => {
    window.kora.updateStatus().then(setUpdate, () => {})
    window.kora.appVersion().then(setAppVersion, () => {})
    return window.kora.onUpdateStatus(setUpdate)
  }, [])

  useEffect(() => {
    window.kora.listOrphans().then(setOrphans, () => {})
  }, [])
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Atualizado na hora de cada atalho: apertos seguidos não podem esperar a resposta do main para somar.
  const sizesRef = useRef<Sizes | null>(null)
  if (state && !sizesRef.current) {
    const { zoom, terminalFontSize, fileFontSize } = state.settings
    sizesRef.current = { zoom, terminalFontSize, fileFontSize }
  }

  const flash = useCallback((text: string, ms = 1200) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }, [])

  // Exceção não tratada no main já não abre o diálogo nativo do Electron: o aviso é este, e o detalhe fica no log.
  useEffect(
    () => window.kora.onAppError(() => flash('Algo deu errado e ficou registrado em Configurações › Suporte.', 6000)),
    [flash]
  )

  const stepSize = useCallback(
    (key: keyof Sizes, direction: 1 | -1 | 0) => {
      const sizes = sizesRef.current ?? DEFAULT_SIZES
      const value = stepValue(sizes[key], direction, SIZE_RANGES[key])
      sizesRef.current = { ...sizes, [key]: value }
      flash(key === 'zoom' ? `Interface ${Math.round(value * 100)}%` : `${SIZE_LABELS[key]} ${value} px`)
      void window.kora.setSizes({ [key]: value }).then(setState)
    },
    [flash]
  )
  const onZoom = useCallback((direction: 1 | -1 | 0) => stepSize('zoom', direction), [stepSize])
  const onTerminalFont = useCallback((direction: 1 | -1 | 0) => stepSize('terminalFontSize', direction), [stepSize])
  const onFileFont = useCallback((direction: 1 | -1 | 0) => stepSize('fileFontSize', direction), [stepSize])

  useZoomShortcuts(onZoom, onTerminalFont, onFileFont)

  useEffect(() => {
    const timer = setTimeout(() => requestIdleCallback(() => void loadCodeView()), MONACO_PRELOAD_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  const lastSavedTabs = useRef<string | null>(null)

  const patchTerminal = useCallback((id: string, patch: Partial<Extract<Tab, { kind: 'terminal' }>>) => {
    setTabs((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([pid, list]) => [
          pid,
          list.map((t) => (t.id === id && t.kind === 'terminal' ? { ...t, ...patch } : t))
        ])
      )
    )
  }, [])

  useEffect(() => {
    void window.kora.getState().then((s) => {
      const restored = restoreTabs(s)
      lastSavedTabs.current = JSON.stringify(tabRefs(restored))
      setState(s)
      setTabs(restored)
      setActiveTab(Object.fromEntries(Object.entries(restored).map(([pid, list]) => [pid, list[0]?.id])))
      setSelectedId(s.projects[0]?.id ?? null)
    })
    const offExit = window.kora.onTerminalExit((id) => {
      terminalBus.forget(id)
      patchTerminal(id, { live: false, activity: null, alert: false })
    })
    const offAgent = window.kora.onTabAgent((id, agent) => patchTerminal(id, { agent }))
    return () => {
      offExit()
      offAgent()
    }
  }, [patchTerminal])

  // Só depois de carregar o estado: um save com a lista vazia inicial apagaria as abas salvas.
  // Abrir/fechar aba salva na hora: com espera, fechar logo depois de abrir (ou fechar o app logo depois
  // de fechar a aba) perdia o save e a aba fechada voltava. Só a troca de título espera 300 ms.
  const pendingTabs = useRef<TabRef[] | null>(null)
  useEffect(() => {
    if (lastSavedTabs.current === null) return
    const refs = tabRefs(tabs)
    const serialized = JSON.stringify(refs)
    if (serialized === lastSavedTabs.current) return
    const save = (): void => {
      lastSavedTabs.current = serialized
      pendingTabs.current = null
      void window.kora.saveTabs(refs)
    }
    const previousIds = (JSON.parse(lastSavedTabs.current) as TabRef[]).map((t) => t.id).join()
    if (refs.map((t) => t.id).join() !== previousIds) {
      save()
      return
    }
    pendingTabs.current = refs
    const timer = setTimeout(save, 300)
    return () => clearTimeout(timer)
  }, [tabs])

  useEffect(() => {
    const flush = (): void => {
      if (pendingTabs.current) window.kora.saveTabsNow(pendingTabs.current)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  // O main segura o X e o Sair enquanto houver arquivo não salvo; avisado na hora, pelo mesmo motivo do Ctrl+W.
  const markDirty = (tabId: string, dirty: boolean): void => {
    if (dirty) dirtyFiles.current.add(tabId)
    else dirtyFiles.current.delete(tabId)
    window.kora.setUnsaved(dirtyFiles.current.size > 0)
    patchFile(tabId, { dirty })
  }

  // Arquivo aberto não volta ao reabrir o app: fechar o programa (X para a bandeja) fecha as abas de arquivo.
  const closeFileTabs = useCallback((): void => {
    setTabs((prev) => Object.fromEntries(Object.entries(prev).map(([pid, list]) => [pid, list.filter((t) => t.kind !== 'file')])))
    setActiveTab((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([pid, active]) => {
          const list = tabsRef.current[pid] ?? []
          if (list.find((t) => t.id === active)?.kind !== 'file') return [pid, active]
          return [pid, list.filter((t) => t.kind !== 'file').at(-1)?.id]
        })
      )
    )
  }, [])

  // Salvar tudo, descartar tudo ou desistir de fechar. Salvamento que falha (conflito com o disco) mantém o app
  // aberto na aba do arquivo, com o aviso do editor.
  const resolveUnsaved = useCallback(
    async (kind: CloseKind): Promise<boolean> => {
      const dirty = Object.entries(tabsRef.current).flatMap(([pid, list]) =>
        list.flatMap((t) => (t.kind === 'file' && isDirty(t) ? [{ projectId: pid, tab: t }] : []))
      )
      if (dirty.length === 0) return true
      const names = dirty.map((d) => d.tab.title)
      const choice = await choose({
        title: dirty.length === 1 ? `Salvar "${names[0]}" antes de fechar?` : `Salvar ${dirty.length} arquivos antes de fechar?`,
        message: (
          <>
            {dirty.length > 1 && <p className="mb-2 text-foreground">{names.join(', ')}</p>}
            <p>Sem salvar, as alterações feitas desde o último Ctrl+S são perdidas.</p>
          </>
        ),
        confirmLabel: kind === 'hide' ? 'Salvar e fechar' : 'Salvar e sair',
        alternativeLabel: 'Descartar alterações'
      })
      if (choice === 'cancel') return false
      if (choice === 'confirm') {
        for (const { projectId, tab } of dirty) {
          if (await fileSavers.current.get(tab.id)?.()) continue
          setSelectedId(projectId)
          setActiveTab((prev) => ({ ...prev, [projectId]: tab.id }))
          return false
        }
      }
      return true
    },
    [choose]
  )

  useEffect(() => {
    const offRequest = window.kora.onCloseRequested((kind) => {
      void resolveUnsaved(kind).then((proceed) => {
        if (!proceed) return window.kora.answerClose(kind, 'cancel')
        // Descartado ou salvo: o main não pode voltar a segurar o fechamento por arquivos que já não contam.
        window.kora.setUnsaved(false)
        if (kind === 'hide') closeFileTabs()
        window.kora.answerClose(kind, 'proceed')
      })
    })
    const offHidden = window.kora.onHidden(closeFileTabs)
    return () => {
      offRequest()
      offHidden()
    }
  }, [resolveUnsaved, closeFileTabs])

  // Instalar fecha o app: arquivo não salvo passa pela mesma pergunta do Sair antes de o main assumir.
  const installUpdate = async (): Promise<boolean> => {
    if (!(await resolveUnsaved('quit'))) return false
    window.kora.setUnsaved(false)
    setInstalling(true)
    const installed = await window.kora.installUpdate().catch(() => false)
    if (!installed) setInstalling(false)
    return installed
  }

  // Aviso de sessão parada: guarda quando cada aba começou a trabalhar e, quando ela para sem você estar olhando,
  // marca a aba como não vista, toca a corda e (com a janela sem foco) manda a notificação do Windows.
  const workingSince = useRef(new Map<string, number>())
  const viewRef = useRef({ selectedId, activeTab })
  viewRef.current = { selectedId, activeTab }
  const stateRef = useRef(state)
  stateRef.current = state

  const [rings, setRings] = useState(0)
  const notifyFinished = useCallback((projectId: string, tab: Extract<Tab, { kind: 'terminal' }>) => {
    setRings((n) => n + 1)
    const alerts = stateRef.current?.settings.alerts
    if (alerts?.sound) playChime()
    if (!alerts?.windowsNotification || document.hasFocus() || !tab.agent) return
    const project = stateRef.current?.projects.find((p) => p.id === projectId)
    const notification = new Notification(`${agentLabel(tab.agent.kind)} está esperando você`, {
      body: project ? `${project.name} · ${tab.title}` : tab.title,
      silent: true
    })
    notification.onclick = () => {
      window.kora.focusWindow()
      setSelectedId(projectId)
      setActiveTab((prev) => ({ ...prev, [projectId]: tab.id }))
    }
  }, [])

  useEffect(
    () =>
      window.kora.onTabActivity((id, activity) => {
        const found = Object.entries(tabsRef.current)
          .flatMap(([projectId, list]) => list.map((tab) => ({ projectId, tab })))
          .find((f) => f.tab.id === id)
        const now = Date.now()
        const since = workingSince.current.get(id) ?? null
        if (activity === 'working') {
          if (since === null) workingSince.current.set(id, now)
        } else {
          workingSince.current.delete(id)
        }
        if (!found || found.tab.kind !== 'terminal') return patchTerminal(id, { activity })
        const { selectedId: shownProject, activeTab: shownTabs } = viewRef.current
        const watching = document.hasFocus() && shownProject === found.projectId && shownTabs[found.projectId] === id
        const alert = finishedUnseen({ previous: found.tab.activity, next: activity, workingSince: since, now, watching })
        patchTerminal(id, alert ? { activity, alert: true } : activity === 'working' ? { activity, alert: false } : { activity })
        if (alert) notifyFinished(found.projectId, found.tab)
      }),
    [patchTerminal, notifyFinished]
  )

  // A aba com aviso que aparece na tela, com a janela em foco, conta como vista.
  useEffect(() => {
    const clearShown = (): void => {
      if (!document.hasFocus() || !selectedId) return
      const shown = (tabsRef.current[selectedId] ?? []).find((t) => t.id === activeTab[selectedId])
      if (shown?.kind === 'terminal' && shown.alert) patchTerminal(shown.id, { alert: false })
    }
    clearShown()
    window.addEventListener('focus', clearShown)
    return () => window.removeEventListener('focus', clearShown)
  }, [selectedId, activeTab, patchTerminal])

  const toggleRightPanel = (): void => {
    setRightPanelOpen((open) => {
      try {
        localStorage.setItem(RIGHT_PANEL_KEY, open ? '0' : '1')
      } catch {
        // preferência só não fica lembrada
      }
      return !open
    })
  }

  const selected = state?.projects.find((p) => p.id === selectedId) ?? null

  const selectTab = (projectId: string, tabId: string): void => {
    setSelectedId(projectId)
    setActiveTab((prev) => ({ ...prev, [projectId]: tabId }))
  }

  // O spawn espera o TerminalView medir o tamanho real (onReady); até lá o pedido fica aqui.
  const pendingLaunch = useRef(new Map<string, { tab: TabRef; how: Launch }>())

  const launch = (projectId: string, tab: TabRef, how: Launch): void => {
    pendingLaunch.current.set(tab.id, { tab, how })
    terminalBus.expect(tab.id)
    patchTerminal(tab.id, { live: true })
    selectTab(projectId, tab.id)
  }

  const spawnWhenReady = async (tabId: string, cols: number, rows: number): Promise<void> => {
    const pending = pendingLaunch.current.get(tabId)
    if (!pending) return
    pendingLaunch.current.delete(tabId)
    try {
      await window.kora.spawnTerminal(pending.tab, cols, rows, pending.how)
      setError(null)
    } catch (err) {
      patchTerminal(tabId, { live: false })
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const newTab = (project: Project, choice: NewTabChoice): void => {
    const list = tabs[project.id] ?? []
    const sameKind = list.filter((t) => t.title.startsWith(DEFAULT_TITLE[choice])).length
    const title = sameKind ? `${DEFAULT_TITLE[choice]} ${sameKind + 1}` : DEFAULT_TITLE[choice]
    const id = crypto.randomUUID()
    if (choice === 'existing') {
      editOnOpen.current.add(id)
      const tab: Tab = { kind: 'terminal', id, title, titleLocked: false, live: false, agent: null }
      setTabs((prev) => ({ ...prev, [project.id]: [...(prev[project.id] ?? []), tab] }))
      selectTab(project.id, id)
      return
    }
    const tab: Tab = { kind: 'terminal', id, title, titleLocked: false, live: true, agent: null }
    setTabs((prev) => ({ ...prev, [project.id]: [...(prev[project.id] ?? []), tab] }))
    launch(project.id, { id, projectId: project.id, title }, { type: choice })
  }

  const editOnOpen = useRef(new Set<string>())

  const resumeTab = (projectId: string, tab: Extract<Tab, { kind: 'terminal' }>, emptyShell: boolean): void => {
    const how: Launch = !emptyShell && tab.agent ? { type: 'resume', agent: tab.agent } : { type: 'shell' }
    launch(projectId, { id: tab.id, projectId, title: tab.title }, how)
  }

  const autoTitle = (tabId: string, title: string): void => {
    setTabs((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([pid, list]) => [
          pid,
          list.map((t) => (t.id === tabId && t.kind === 'terminal' && !t.titleLocked ? { ...t, title } : t))
        ])
      )
    )
  }

  // Nome vazio devolve a aba ao título automático do programa que roda nela.
  const renameTab = (tabId: string, name: string): void => {
    patchTerminal(tabId, name ? { title: name, titleLocked: true } : { titleLocked: false })
  }

  const setTabAgent = (tab: TabRef, agent: AgentSession | null): void => {
    patchTerminal(tab.id, { agent })
    void window.kora.setTabAgent(tab, agent)
  }

  // Conversa listada no painel: se já está numa aba, só vai até ela; senão cria a aba já vinculada.
  const openSession = (project: Project, session: SessionSummary, launchNow: boolean): void => {
    const existing = (tabs[project.id] ?? []).find(
      (t) => t.kind === 'terminal' && t.agent?.sessionId === session.sessionId
    )
    if (existing) {
      selectTab(project.id, existing.id)
      return
    }
    const agent: AgentSession = { kind: session.kind, sessionId: session.sessionId }
    const titleLocked = session.named === true
    const ref: TabRef = { id: crypto.randomUUID(), projectId: project.id, title: session.title, titleLocked }
    const tab: Tab = { kind: 'terminal', id: ref.id, title: ref.title, titleLocked, live: false, agent }
    setTabs((prev) => ({ ...prev, [project.id]: [...(prev[project.id] ?? []), tab] }))
    void window.kora.setTabAgent(ref, agent)
    if (launchNow) launch(project.id, ref, { type: 'resume', agent })
    else selectTab(project.id, ref.id)
  }

  const openFile = (project: Project, path: string): void => {
    const viewer = viewerFor(path)
    if (viewer === 'external') {
      void window.kora.openFile(project.id, path).catch((err: unknown) => setError(ipcErrorMessage(err)))
      return
    }
    const existing = (tabs[project.id] ?? []).find((t) => t.kind === 'file' && t.path === path)
    const id = existing?.id ?? `file:${project.id}:${path}`
    if (!existing) {
      const title = path.split(/[\\/]/).pop() ?? path
      const tab: Tab = { kind: 'file', id, title, path, viewer, editing: viewer === 'code', dirty: false }
      setTabs((prev) => ({ ...prev, [project.id]: [...(prev[project.id] ?? []), tab] }))
    }
    selectTab(project.id, id)
  }

  const movePathInTabs = (projectId: string, from: string, to: string): void =>
    setTabs((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).map((t) => {
        if (t.kind !== 'file' || !isUnder(t.path, from)) return t
        const path = to + t.path.slice(from.length)
        const viewer = viewerFor(path)
        return { ...t, path, title: path.split(/[\\/]/).pop() ?? path, viewer: viewer === 'external' ? t.viewer : viewer }
      })
    }))

  const hasUnsavedUnder = (projectId: string, rel: string): boolean =>
    (tabs[projectId] ?? []).some((t) => t.kind === 'file' && isDirty(t) && isUnder(t.path, rel))

  const [reveal, setReveal] = useState<{ path: string; n: number } | null>(null)

  // Abre o arquivo, mostra onde ele está na árvore (expandindo as pastas) e, se veio com :linha, vai até ela.
  const openFromTerminal = (projectId: string, rel: string, line: number | null): void => {
    const project = state?.projects.find((p) => p.id === projectId)
    if (!project) return
    openFile(project, rel)
    setReveal((r) => ({ path: rel, n: (r?.n ?? 0) + 1 }))
    if (line) {
      const n = Date.now()
      setTabs((prev) => ({
        ...prev,
        [projectId]: (prev[projectId] ?? []).map((t) => (t.kind === 'file' && t.path === rel ? { ...t, jump: { line, n } } : t))
      }))
    }
  }

  const patchFile = (id: string, patch: Partial<Extract<Tab, { kind: 'file' }>>): void => {
    setTabs((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([pid, list]) => [
          pid,
          list.map((t) => (t.id === id && t.kind === 'file' ? { ...t, ...patch } : t))
        ])
      )
    )
  }

  // Pelo atalho a aba some sem o mouse ter apontado para ela: terminal rodando pede confirmação (Enter aceita).
  useCloseTabShortcut(async () => {
    const projectId = selectedId
    const tab = projectId ? (tabs[projectId] ?? []).find((t) => t.id === activeTab[projectId]) : undefined
    if (!projectId || !tab) return
    if (tab.kind === 'terminal' && tab.live) {
      const ok = await confirm({
        title: `Fechar o terminal "${tab.title}"?`,
        message: tab.agent
          ? 'O processo é encerrado. A conversa fica salva e pode ser retomada pela aba Sessões.'
          : 'O que estiver rodando nele é encerrado.',
        confirmLabel: 'Fechar'
      })
      if (!ok) return
    }
    await closeTab(projectId, tab.id)
  })

  // Abre a edição do nome na barra de cima, onde a aba atual está sempre visível.
  useRenameTabShortcut(() => {
    const tab = selectedId ? (tabs[selectedId] ?? []).find((t) => t.id === activeTab[selectedId]) : undefined
    if (tab?.kind === 'terminal') setRenameRequest((r) => ({ tabId: tab.id, where: 'bar', n: (r?.n ?? 0) + 1 }))
  })

  const closeTab = async (projectId: string, tabId: string): Promise<void> => {
    const list = tabs[projectId] ?? []
    const tab = list.find((t) => t.id === tabId)
    if (tab?.kind === 'file' && isDirty(tab)) {
      const choice = await choose({
        title: `Salvar "${tab.title}" antes de fechar?`,
        message: 'Fechando sem salvar, as alterações feitas desde o último Ctrl+S são perdidas.',
        confirmLabel: 'Salvar e fechar',
        alternativeLabel: 'Fechar sem salvar'
      })
      if (choice === 'cancel') return
      // Salvamento que não aconteceu (conflito com o disco, erro) mantém a aba aberta com o aviso no editor.
      if (choice === 'confirm' && !(await fileSavers.current.get(tabId)?.())) return
    }
    if (tab?.kind === 'terminal' && tab.live) {
      window.kora.killTerminal(tabId)
      terminalBus.forget(tabId)
    }
    const remaining = list.filter((t) => t.id !== tabId)
    setTabs((prev) => ({ ...prev, [projectId]: remaining }))
    setActiveTab((prev) =>
      prev[projectId] === tabId ? { ...prev, [projectId]: remaining.at(-1)?.id } : prev
    )
  }

  const openWorktree = async (path: string): Promise<void> => {
    try {
      const next = await window.kora.addProjectPath(path)
      setState(next)
      const project = next.projects.find((p) => p.path.toLowerCase() === path.toLowerCase())
      if (project) setSelectedId(project.id)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const addProject = async (): Promise<void> => {
    const before = new Set(state?.projects.map((p) => p.id))
    const next = await window.kora.addProject()
    setState(next)
    const added = next.projects.find((p) => !before.has(p.id))
    if (added) setSelectedId(added.id)
  }

  const reorderTab = (projectId: string, fromId: string, toId: string, place: Place): void =>
    setTabs((prev) => ({ ...prev, [projectId]: reorder(prev[projectId] ?? [], fromId, toId, place) }))

  // A lateral muda na hora; o main confere a organização e devolve o estado salvo, que prevalece.
  const saveLayout = (projects: Project[], groups: ProjectGroup[]): void => {
    if (!state) return
    const sorted = sortBySection(projects, groups)
    setState({ ...state, projects: sorted, groups })
    window.kora
      .saveLayout({ groups, placements: sorted.map((p) => ({ id: p.id, hidden: Boolean(p.hidden), groupId: p.groupId ?? null })) })
      .then(setState, (err: unknown) => {
        setError(ipcErrorMessage(err))
        void window.kora.getState().then(setState)
      })
  }

  const arrangeProject = (draggedId: string, drop: ProjectDrop): void => {
    if (!state) return
    const projects = arrangeProjects(state.projects, draggedId, drop, state.groups)
    if (projects !== state.projects) saveLayout(projects, state.groups)
  }

  const groupAction = async (action: GroupAction): Promise<void> => {
    if (!state) return
    const groups = state.groups
    const patch = (id: string, change: Partial<ProjectGroup>): ProjectGroup[] =>
      groups.map((g) => (g.id === id ? { ...g, ...change } : g))
    switch (action.kind) {
      case 'create': {
        const group: ProjectGroup = { id: crypto.randomUUID(), name: action.name.slice(0, GROUP_NAME_MAX) }
        const withParent = action.parentId ? { ...group, parentId: action.parentId } : group
        // Criar dentro de uma categoria recolhida a abre, senão a subcategoria nova nem apareceria.
        const opened = action.parentId ? groups.map((g) => (g.id === action.parentId ? { ...g, collapsed: false } : g)) : groups
        return saveLayout(state.projects, [...opened, withParent])
      }
      case 'rename':
        return saveLayout(state.projects, patch(action.id, { name: action.name.slice(0, GROUP_NAME_MAX) }))
      case 'toggle':
        return saveLayout(state.projects, patch(action.id, { collapsed: !groups.find((g) => g.id === action.id)?.collapsed }))
      case 'hide':
        return saveLayout(state.projects, setGroupHidden(groups, action.id, action.hidden))
      case 'nest': {
        const next = nestGroup(groups, action.id, action.parentId)
        if (next !== groups) saveLayout(state.projects, next)
        return
      }
      case 'place': {
        const next = placeGroup(groups, action.id, action.targetId, action.place)
        if (next !== groups) saveLayout(state.projects, next)
        return
      }
      case 'move':
        return saveLayout(state.projects, moveAmongSiblings(groups, action.id, action.delta))
      case 'remove': {
        const group = groups.find((g) => g.id === action.id)
        if (!group) return
        const ok = await confirm({
          title: `Excluir a categoria "${group.name}"?`,
          message: 'Só a divisória sai: os projetos e as subcategorias dela sobem um nível. Nenhuma pasta é apagada.',
          confirmLabel: 'Excluir categoria',
          danger: true
        })
        if (!ok) return
        const next = removeGroup(groups, state.projects, action.id)
        return saveLayout(next.projects, next.groups)
      }
    }
  }

  const removeProject = async (project: Project): Promise<void> => {
    const open = tabs[project.id] ?? []
    const running = open.filter((t) => t.kind === 'terminal' && t.live).length
    const ok = await confirm({
      title: `Remover "${project.name}" da lista?`,
      message: (
        <>
          <p>A pasta e os arquivos continuam no computador; só o vínculo com o Kora é desfeito.</p>
          {running > 0 && (
            <p className="mt-2 text-foreground">
              {running === 1 ? '1 terminal aberto será fechado.' : `${running} terminais abertos serão fechados.`}
            </p>
          )}
        </>
      ),
      confirmLabel: 'Remover da lista',
      danger: true
    })
    if (!ok) return
    for (const tab of open) if (tab.kind === 'terminal') terminalBus.forget(tab.id)
    const next = await window.kora.removeProject(project.id)
    setTabs((prev) => {
      const copy = { ...prev }
      delete copy[project.id]
      return copy
    })
    setState(next)
    if (selectedId === project.id) setSelectedId(next.projects[0]?.id ?? null)
  }

  // Suspender encerra o processo (Claude/Codex e o shell) e libera a memória, mas a aba fica com o
  // vínculo da sessão e o "Continuar chat" — é parar o trabalho sem fechar a aba nem o app.
  const suspendTab = (tabId: string): void => {
    window.kora.killTerminal(tabId)
    terminalBus.forget(tabId)
    patchTerminal(tabId, { live: false })
  }

  const tabMenuItems = (projectId: string, tab: Tab, where: TabPlace): MenuItem[] => {
    const close: MenuItem = { label: 'Fechar aba', danger: true, onSelect: () => void closeTab(projectId, tab.id) }
    if (tab.kind === 'file') {
      return [
        { label: 'Mostrar no Explorer', onSelect: () => void window.kora.revealInExplorer(projectId, tab.path) },
        { label: 'Copiar caminho relativo', onSelect: () => void copyPath(tab.path) },
        'separator',
        close
      ]
    }
    const items: MenuItem[] = [
      { label: 'Renomear', onSelect: () => setRenameRequest((r) => ({ tabId: tab.id, where, n: (r?.n ?? 0) + 1 })) }
    ]
    if (tab.live) {
      items.push({
        label: tab.agent ? 'Suspender sessão' : 'Encerrar terminal',
        onSelect: () => suspendTab(tab.id)
      })
    } else if (tab.agent) {
      items.push({ label: 'Continuar chat', onSelect: () => resumeTab(projectId, tab, false) })
    } else {
      items.push({ label: 'Abrir terminal', onSelect: () => resumeTab(projectId, tab, true) })
    }
    if (tab.agent) {
      const sessionId = tab.agent.sessionId
      items.push({
        label: 'Copiar ID da sessão',
        onSelect: () => void navigator.clipboard.writeText(sessionId).then(() => flash('ID da sessão copiado'))
      })
    }
    return [...items, 'separator', close]
  }

  const openTabMenu = (projectId: string, tabId: string, where: TabPlace, x: number, y: number): void =>
    setTabMenu({ projectId, tabId, where, x, y })

  if (!state) return <div className="h-full bg-background" />

  const menuTab = tabMenu ? (tabs[tabMenu.projectId] ?? []).find((t) => t.id === tabMenu.tabId) : undefined

  const projectTabs = selected ? (tabs[selected.id] ?? []) : []

  return (
    <div className="flex h-full">
      <Sidebar
        projects={state.projects}
        groups={state.groups}
        onGroupAction={(action) => void groupAction(action)}
        tabs={tabs}
        selectedId={selectedId}
        activeTab={activeTab}
        onSelectProject={setSelectedId}
        onSelectTab={selectTab}
        onCloseTab={(projectId, tabId) => void closeTab(projectId, tabId)}
        onRenameTab={(_projectId, tabId, title) => renameTab(tabId, title)}
        onTabContextMenu={(projectId, tabId, x, y) => openTabMenu(projectId, tabId, 'side', x, y)}
        renameRequest={renameRequest?.where === 'side' ? renameRequest : null}
        onNewTab={newTab}
        onAdd={() => void addProject()}
        onRemove={(p) => void removeProject(p)}
        onArrangeProject={arrangeProject}
        zoom={state.settings.zoom}
        terminalFontSize={state.settings.terminalFontSize}
        fileFontSize={state.settings.fileFontSize}
        onZoom={onZoom}
        onTerminalFont={onTerminalFont}
        onFileFont={onFileFont}
        onReorderTab={reorderTab}
        theme={state.settings.theme}
        onSetTheme={(theme) => void window.kora.setTheme(theme).then(setState)}
        update={update}
        onInstallUpdate={installUpdate}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={projectTabs}
          activeId={selected ? activeTab[selected.id] : undefined}
          rightPanelOpen={rightPanelOpen}
          onSelect={(id) => selected && selectTab(selected.id, id)}
          onClose={(id) => selected && closeTab(selected.id, id)}
          onRename={renameTab}
          onContextMenu={(tabId, x, y) => selected && openTabMenu(selected.id, tabId, 'bar', x, y)}
          renameRequest={renameRequest?.where === 'bar' ? renameRequest : null}
          onNew={(choice) => selected && newTab(selected, choice)}
          onToggleRightPanel={toggleRightPanel}
          projectId={selected?.id ?? ''}
          onReorder={(fromId, toId, place) => selected && reorderTab(selected.id, fromId, toId, place)}
          atWindowEdge={!(rightPanelOpen && selected)}
        />
        {error && (
          <div className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</div>
        )}

        <div className="relative flex-1 bg-canvas">
          {Object.entries(tabs).flatMap(([projectId, list]) =>
            list.map((tab) => {
              const visible = projectId === selectedId && activeTab[projectId] === tab.id
              if (tab.kind === 'file') {
                if (tab.viewer === 'pdf') {
                  return (
                    <PdfView
                      key={tab.id}
                      projectId={projectId}
                      path={tab.path}
                      visible={visible}
                      onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                    />
                  )
                }
                if (tab.viewer === 'image') {
                  return (
                    <ImageView
                      key={tab.id}
                      projectId={projectId}
                      path={tab.path}
                      visible={visible}
                      onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                    />
                  )
                }
                if (tab.viewer === 'markdown' && !tab.editing) {
                  return (
                    <MarkdownView
                      key={`${tab.id}:preview`}
                      projectId={projectId}
                      path={tab.path}
                      visible={visible}
                      fontSize={state.settings.fileFontSize}
                      onEdit={() => patchFile(tab.id, { editing: true })}
                      onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                    />
                  )
                }
                return (
                  <Suspense key={`${tab.id}:edit`} fallback={<div className="absolute inset-0 bg-canvas" />}>
                    <CodeView
                      projectId={projectId}
                      path={tab.path}
                      visible={visible}
                      fontSize={state.settings.fileFontSize}
                      onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                      onSaveHandle={(save) => (save ? fileSavers.current.set(tab.id, save) : fileSavers.current.delete(tab.id))}
                      jump={tab.jump}
                      onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                      headerExtra={
                        tab.viewer === 'markdown' && (
                          <ModeToggle
                            editing
                            previewDisabledReason={tab.dirty ? 'Salve com Ctrl+S antes de visualizar' : undefined}
                            onChange={(editing) => !editing && patchFile(tab.id, { editing: false })}
                          />
                        )
                      }
                    />
                  </Suspense>
                )
              }
              if (!tab.live) {
                return (
                  <DormantView
                    key={`${tab.id}:dormant`}
                    agent={tab.agent}
                    visible={visible}
                    startEditing={editOnOpen.current.has(tab.id)}
                    onResume={() => resumeTab(projectId, tab, false)}
                    onShell={() => resumeTab(projectId, tab, true)}
                    onSetAgent={(agent) => {
                      editOnOpen.current.delete(tab.id)
                      setTabAgent({ id: tab.id, projectId, title: tab.title }, agent)
                    }}
                  />
                )
              }
              return (
                <TerminalView
                  key={tab.id}
                  id={tab.id}
                  visible={visible}
                  onTitle={(title) => autoTitle(tab.id, title)}
                  onReady={(cols, rows) => void spawnWhenReady(tab.id, cols, rows)}
                  fontSize={state.settings.terminalFontSize}
                  projectId={projectId}
                  onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                />
              )
            })
          )}

          {selected && projectTabs.length === 0 && (
            <EmptyState
              ring={rings}
              title={selected.name}
              detail={selected.path}
              actions={[
                { label: 'Claude', onClick: () => newTab(selected, 'claude') },
                { label: 'Codex', onClick: () => newTab(selected, 'codex') },
                { label: 'Terminal', onClick: () => newTab(selected, 'shell') }
              ]}
            />
          )}
          {!selected && (
            <EmptyState
              ring={rings}
              title="Nenhum projeto selecionado"
              detail="Adicione uma pasta na barra lateral para começar."
              actions={[{ label: 'Adicionar projeto', onClick: () => void addProject() }]}
            />
          )}
        </div>
      </main>

      {rightPanelOpen && selected && (
        <RightPanel
          key={selected.id}
          project={selected}
          openSessions={
            new Map(
              projectTabs.flatMap((t) =>
                t.kind === 'terminal' && t.agent ? [[t.agent.sessionId, t.titleLocked ? t.title : null] as const] : []
              )
            )
          }
          onOpenFile={(path) => openFile(selected, path)}
          onOpenSession={(session) => openSession(selected, session, true)}
          onPinSession={(session) => openSession(selected, session, false)}
          onOpenWorktree={(path) => void openWorktree(path)}
          onPathMoved={(from, to) => movePathInTabs(selected.id, from, to)}
          hasUnsavedUnder={(rel) => hasUnsavedUnder(selected.id, rel)}
          reveal={reveal}
        />
      )}

      <OrphanDialog
        survivors={orphans}
        onKill={(key) => {
          setOrphans((list) => list.filter((o) => o.key !== key))
          void window.kora.killOrphan(key)
        }}
        onKillAll={() => {
          setOrphans([])
          void window.kora.killAllOrphans()
        }}
        onKeep={() => {
          setOrphans([])
          void window.kora.keepOrphans()
        }}
      />

      {settingsOpen && (
        <SettingsDialog
          version={appVersion}
          update={update}
          installing={installing}
          onCheck={() => void window.kora.checkUpdate()}
          onInstall={() => void installUpdate()}
          onClose={closeSettings}
          alerts={state.settings.alerts}
          onAlertsChange={(alerts) => void window.kora.setAlerts(alerts).then(setState)}
          onPreviewSound={playChime}
          support={{
            errors: errorSummary,
            copyRecent: async () => navigator.clipboard.writeText(await window.kora.recentErrors()),
            saveFile: () => window.kora.saveDiagnostic(),
            openFolder: () => window.kora.openLogsFolder()
          }}
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-md border bg-card px-3 py-1.5 text-xs font-medium shadow-lg">
          {toast}
        </div>
      )}

      {tabMenu && menuTab && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabMenu.projectId, menuTab, tabMenu.where)}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  )
}

function EmptyState(props: {
  title: string
  detail: string
  actions: { label: string; onClick(): void }[]
  // Muda a cada sino tocado em outra sessão: a chave nova recria o símbolo e ele balança uma vez.
  ring: number
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span key={props.ring} data-empty-symbol className={cn('mb-3 inline-flex', props.ring > 0 && 'kora-balanca')}>
        <SymbolMark size={104} body="var(--brand-ghost)" arm="var(--brand-ghost)" />
      </span>
      <div className="text-sm font-medium">{props.title}</div>
      <div className="max-w-full truncate text-xs text-muted-foreground">{props.detail}</div>
      <div className="mt-1 flex gap-2">
        {props.actions.map((a, i) => (
          <Button key={a.label} variant={i === 0 ? 'primary' : 'secondary'} onClick={a.onClick}>
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
