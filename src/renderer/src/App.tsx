import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { MarkdownTab } from '@/components/MarkdownView'
import { PdfView } from '@/components/PdfView'
import { ImageView, isSvg, SVG_MODES, SvgTab } from '@/components/ImageView'
import { ExternalView } from '@/components/ExternalView'
import { MediaView } from '@/components/MediaView'
import { NotebookView } from '@/components/NotebookView'
import { isTextSheet, SheetModeToggle, SheetTab, type SheetMode } from '@/components/SpreadsheetView'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { ModeToggle, type MarkdownMode } from '@/components/ModeToggle'
import { useZoomShortcuts } from '@/lib/use-zoom-shortcuts'
import { TAB_SHORTCUT_LABEL, useTabShortcuts, type TabCommand } from '@/lib/use-tab-shortcuts'
import { useRenameTabShortcut } from '@/lib/use-rename-tab-shortcut'
import { useQuickOpenShortcut } from '@/lib/use-quick-open-shortcut'
import {
  changeMayRemove,
  fileTabsToClose,
  moveFileTab,
  moveRecentPaths,
  placeCompareTab,
  placeDiffTab,
  placeFileTab,
  rememberClosed,
  reopenClosed,
  siblingFileTab,
  tabShowsPathUnder,
  type ClosedFileTab,
  type CloseScope,
  type GitDiffOpen,
  type OpenAtOptions,
  type OpenFileOptions
} from '@/lib/file-tabs'
import { QuickOpen } from '@/components/QuickOpen'
import { Button } from '@/brand/Button'
import { SymbolMark } from '@/brand/Logo'
import { OrphanDialog, type OrphanSurvivor } from '@/components/OrphanDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { MobileDialog } from '@/components/MobilePanel'
import { playChime } from '@/lib/chime'
import { copyPath } from '@/lib/copied-path'
import { finishedUnseen } from '@/lib/alerts'
import { agentLabel } from '@/components/AgentIcon'
import type { UpdateStatus } from '@shared/update'

// O Monaco pesa vários MB e a primeira abertura levava ~1,6 s; fora do caminho do boot, mas pré-carregado
// quando o app fica ocioso, para o primeiro clique num arquivo já encontrar o editor pronto.
const loadCodeView = () => import('@/components/CodeView').then((m) => ({ default: m.CodeView }))
const CodeView = lazy(loadCodeView)
const DiffView = lazy(() => import('@/components/DiffView').then((m) => ({ default: m.DiffView })))
const CompareView = lazy(() => import('@/components/CompareView').then((m) => ({ default: m.CompareView })))
const MONACO_PRELOAD_DELAY_MS = 3000
import { DormantView } from '@/components/DormantView'
import { ViewerBoundary } from '@/components/ViewerBoundary'
import { useChoose, useConfirm } from '@/components/ConfirmDialog'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { Icon } from '@/brand/icons'
import type { RenameRequest, TabPlace } from '@/components/TabBar'
import { LinkedRenameContext, type LinkedRename } from '@/components/EditableTitle'
import type { NewTabChoice } from '@/components/NewTabMenu'
import { terminalBus } from '@/lib/terminal-bus'
import { reconcileTabRefs } from '@shared/tab-sync'
import { useTabMemory } from '@/lib/memory-budget'
import { saveAllScrollbacks, saveScrollbackNow } from '@/lib/scrollback'

type TabsByProject = Record<string, Tab[]>
const NO_RECENT: string[] = []

// Cada aba no seu limite de erro: um visualizador que lança ao desenhar não desmonta a janela com os terminais.
const guarded =
  (isVisible: (tab: Tab) => boolean, render: (tab: Tab) => React.ReactNode) =>
  (tab: Tab): React.ReactNode => (
    <ViewerBoundary key={tab.id} visible={isVisible(tab)}>
      {render(tab)}
    </ViewerBoundary>
  )

type Sizes = { zoom: number; terminalFontSize: number; fileFontSize: number }
const SIZE_RANGES: Record<keyof Sizes, typeof ZOOM> = { zoom: ZOOM, terminalFontSize: TERMINAL_FONT, fileFontSize: FILE_FONT }
const DEFAULT_SIZES: Sizes = { zoom: ZOOM.default, terminalFontSize: TERMINAL_FONT.default, fileFontSize: FILE_FONT.default }
const SIZE_LABELS: Record<Exclude<keyof Sizes, 'zoom'>, string> = { terminalFontSize: 'Terminal', fileFontSize: 'Arquivos' }

const RIGHT_PANEL_KEY = 'kora.rightPanelOpen'
const DEFAULT_TITLE: Record<NewTabChoice, string> = {
  shell: 'Terminal',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
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
      agent: saved.agent,
      ...(saved.dir ? { dir: saved.dir } : {})
    }
    ;(byProject[saved.projectId] ??= []).push(tab)
  }
  return byProject
}

function tabRefs(tabs: TabsByProject): TabRef[] {
  return Object.entries(tabs).flatMap(([projectId, list]) =>
    list.flatMap((t) =>
      t.kind === 'terminal' ? [{ id: t.id, projectId, title: t.title, titleLocked: t.titleLocked, ...(t.dir ? { dir: t.dir } : {}) }] : []
    )
  )
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<KoraState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<TabsByProject>({})
  const [activeTab, setActiveTab] = useState<Record<string, string | undefined>>({})
  const [rightPanelOpen, setRightPanelOpen] = useState(initialRightPanel)
  const [error, setError] = useState<string | null>(null)
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
  const [tabMenu, setTabMenu] = useState<{ projectId: string; tabId: string; where: TabPlace; x: number; y: number } | null>(null)
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null)
  const [linkedRename, setLinkedRename] = useState<{ tabId: string; title: string; draft: string } | null>(null)
  const [commitDrafts, setCommitDrafts] = useState<Record<string, string>>({})
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
  const [mobileOpen, setMobileOpen] = useState(false)
  const closeMobile = useCallback(() => setMobileOpen(false), [])
  const [errorSummary, setErrorSummary] = useState<ErrorSummary | null>(null)
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  const openFileTabs = useMemo(
    () => Object.entries(tabs).flatMap(([projectId, list]) => list.flatMap((tab) => (tab.kind === 'file' ? [{ projectId, tab }] : []))),
    [tabs]
  )
  const shownTabId = selectedId && !missing.has(selectedId) ? activeTab[selectedId] : undefined
  const shownTabIds = useMemo(() => (shownTabId ? [shownTabId] : []), [shownTabId])
  const tabMemory = useTabMemory({ fileTabs: openFileTabs, visibleIds: shownTabIds, isDirty })
  const checkMissing = useCallback(() => {
    window.kora.missingProjects().then(
      (ids) => setMissing((prev) => (ids.length === prev.size && ids.every((id) => prev.has(id)) ? prev : new Set(ids))),
      () => {}
    )
  }, [])
  // A pasta some por fora do Kora: confere ao voltar para a janela, ao trocar de projeto e quando o main pede
  // para reler tudo (é o que ele faz quando a pasta de um projeto observado deixa de existir).
  useEffect(() => {
    checkMissing()
    window.addEventListener('focus', checkMissing)
    const offFiles = window.kora.onFilesChanged((_projectId, change) => change.rescan && checkMissing())
    return () => {
      window.removeEventListener('focus', checkMissing)
      offFiles()
    }
  }, [checkMissing])
  useEffect(checkMissing, [selectedId, state?.projects, checkMissing])
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
    void Promise.all([
      window.kora.getState(),
      window.kora.takeResumeAfterUpdate(),
      window.kora.takeRecoveryNotice(),
      window.kora.reattachTerminals()
    ]).then(([s, resume, notice, alive]) => {
      setRecoveryNotice(notice)
      const restored = restoreTabs(s)
      const running = new Map(alive.map((t) => [t.id, t.activity]))
      // Quem rodava antes da atualização volta a rodar, como no "Continuar chat", sem trocar a aba aberta.
      // Quem sobreviveu à queda da interface só volta a aparecer, ligado ao mesmo processo.
      for (const [projectId, list] of Object.entries(restored)) {
        restored[projectId] = list.map((tab) => {
          if (tab.kind !== 'terminal') return tab
          if (running.has(tab.id)) {
            reattached.current.add(tab.id)
            return { ...tab, live: true, activity: running.get(tab.id) ?? null }
          }
          if (!resume.includes(tab.id)) return tab
          const how: Launch = tab.agent ? { type: 'resume', agent: tab.agent } : { type: 'shell' }
          pendingLaunch.current.set(tab.id, { tab: { id: tab.id, projectId, title: tab.title }, how })
          terminalBus.expect(tab.id)
          return { ...tab, live: true }
        })
      }
      lastSavedTabs.current = JSON.stringify(tabRefs(restored))
      setState(s)
      setTabs(restored)
      setActiveTab(Object.fromEntries(Object.entries(restored).map(([pid, list]) => [pid, list[0]?.id])))
      setSelectedId(s.projects[0]?.id ?? null)
    })
    const offExit = window.kora.onTerminalExit((id) => {
      // O processo saiu: guarda a tela antes de adormecer a aba.
      saveScrollbackNow(id)
      reattached.current.delete(id)
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
  const pendingBaseline = useRef<TabRef[] | undefined>(undefined)
  useEffect(() => {
    if (lastSavedTabs.current === null) return
    const refs = tabRefs(tabs)
    const serialized = JSON.stringify(refs)
    if (serialized === lastSavedTabs.current) return
    const baseline = JSON.parse(lastSavedTabs.current) as TabRef[]
    const save = (): void => {
      lastSavedTabs.current = serialized
      pendingTabs.current = null
      void window.kora.saveTabs(refs, baseline)
    }
    const previousIds = (JSON.parse(lastSavedTabs.current) as TabRef[]).map((t) => t.id).join()
    if (refs.map((t) => t.id).join() !== previousIds) {
      save()
      return
    }
    pendingTabs.current = refs
    pendingBaseline.current = baseline
    const timer = setTimeout(save, 300)
    return () => clearTimeout(timer)
  }, [tabs])

  useEffect(() => {
    const flush = (): void => {
      if (pendingTabs.current) window.kora.saveTabsNow(pendingTabs.current, pendingBaseline.current)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // Arquivo aberto apagado (ou movido) por fora: a aba fica, riscada, e volta ao normal se ele reaparecer.
  useEffect(
    () =>
      window.kora.onFilesChanged((projectId, change) => {
        const paths = new Set(
          (tabsRef.current[projectId] ?? []).flatMap((t) => (t.kind === 'file' && !t.diff && changeMayRemove(change, t.path) ? [t.path] : []))
        )
        for (const path of paths) {
          window.kora.fileExists(projectId, path).then(
            (exists) =>
              setTabs((prev) => {
                const list = prev[projectId]
                const stale = (t: Tab): boolean => t.kind === 'file' && !t.diff && t.path === path && Boolean(t.deleted) === exists
                if (!list?.some(stale)) return prev
                return { ...prev, [projectId]: list.map((t) => (stale(t) ? { ...t, deleted: !exists } : t)) }
              }),
            () => {}
          )
        }
      }),
    []
  )

  // Arquivos vistos por último em cada projeto, o mais recente primeiro: abrem a lista do Ctrl+P.
  const [recentFiles, setRecentFiles] = useState<Record<string, string[]>>({})
  const [quickOpen, setQuickOpen] = useState(false)

  // O celular abriu, fechou, renomeou, suspendeu ou retomou abas: o main manda o estado e a interface se ajusta
  // sem perder o que mudou aqui desde o último save. Abas de arquivo ficam onde estão.
  useEffect(
    () =>
      window.kora.onMobileState((snapshot) => {
        if (lastSavedTabs.current === null) return
        const baseline = JSON.parse(lastSavedTabs.current) as TabRef[]
        const refs = reconcileTabRefs(snapshot.state.tabs, tabRefs(tabsRef.current), baseline)
        lastSavedTabs.current = JSON.stringify(
          snapshot.state.tabs.map(({ id, projectId, title, titleLocked, dir }) => ({ id, projectId, title, titleLocked, ...(dir ? { dir } : {}) }))
        )
        pendingTabs.current = null
        const remote = new Map(snapshot.tabs.map((tab) => [tab.id, tab]))
        for (const tab of snapshot.tabs) if (tab.live) terminalBus.expect(tab.id)
        setState(snapshot.state)
        setTabs((previous) => {
          const terminalsByProject: TabsByProject = {}
          for (const ref of refs) {
            const old = previous[ref.projectId]?.find((t) => t.id === ref.id)
            const now = remote.get(ref.id)
            const tab: Tab = {
              ...(old?.kind === 'terminal' ? old : {}),
              kind: 'terminal',
              id: ref.id,
              title: ref.title,
              titleLocked: ref.titleLocked ?? false,
              live: pendingLaunch.current.has(ref.id) || (now?.live ?? false),
              agent: now?.agent ?? null,
              activity: now?.activity,
              ...(ref.dir ? { dir: ref.dir } : {})
            }
            ;(terminalsByProject[ref.projectId] ??= []).push(tab)
          }
          const next: TabsByProject = {}
          // Projeto tirado da lista pelo celular leva junto as abas de arquivo dele, como o Remover da lista do PC.
          const known = new Set(snapshot.state.projects.map((p) => p.id))
          for (const pid of new Set([...Object.keys(previous), ...Object.keys(terminalsByProject)])) {
            if (!known.has(pid)) continue
            const terminals = terminalsByProject[pid] ?? []
            let index = 0
            const list = (previous[pid] ?? []).flatMap<Tab>((tab) =>
              tab.kind === 'file' ? [tab] : terminals[index] ? [terminals[index++]!] : []
            )
            list.push(...terminals.slice(index))
            next[pid] = list
          }
          return next
        })
        const open = new Set(refs.map((ref) => ref.id))
        setActiveTab((prev) => {
          let changed = false
          const fixed = { ...prev }
          for (const [pid, active] of Object.entries(prev)) {
            const isTerminal = (tabsRef.current[pid] ?? []).some((t) => t.id === active && t.kind === 'terminal')
            if (active && isTerminal && !open.has(active)) {
              fixed[pid] = refs.filter((ref) => ref.projectId === pid).at(-1)?.id
              changed = true
            }
          }
          return changed ? fixed : prev
        })
      }),
    []
  )
  // O main segura o X e o Sair enquanto houver arquivo não salvo; avisado na hora, pelo mesmo motivo do Ctrl+W.
  const markDirty = (tabId: string, dirty: boolean): void => {
    if (dirty) dirtyFiles.current.add(tabId)
    else dirtyFiles.current.delete(tabId)
    window.kora.setUnsaved(dirtyFiles.current.size > 0)
    // Editar a pré-visualização a fixa: o próximo clique na árvore não pode levar embora a edição.
    patchFile(tabId, dirty ? { dirty, preview: false } : { dirty })
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

  useEffect(() => window.kora.onFlushScrollback(saveAllScrollbacks), [])

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
    await saveAllScrollbacks()
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
  // Abas cujo pty continuou rodando enquanto a interface recarregava; vale até o processo sair.
  const reattached = useRef(new Set<string>())

  const launch = (projectId: string, tab: TabRef, how: Launch): void => {
    if (missing.has(projectId)) return setSelectedId(projectId)
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
    if (missing.has(project.id)) return setSelectedId(project.id)
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

  // "Abrir no terminal integrado": shell novo começando na pasta, com o nome dela na aba. A raiz é o terminal comum.
  const openTerminalIn = (project: Project, dir: string): void => {
    if (!dir) return newTab(project, 'shell')
    if (missing.has(project.id)) return setSelectedId(project.id)
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
    const same = (tabs[project.id] ?? []).filter((t) => t.kind === 'terminal' && (t.title === name || t.title.startsWith(`${name} `))).length
    const title = same ? `${name} ${same + 1}` : name
    const id = crypto.randomUUID()
    const tab: Tab = { kind: 'terminal', id, title, titleLocked: false, live: true, agent: null, dir }
    setTabs((prev) => ({ ...prev, [project.id]: [...(prev[project.id] ?? []), tab] }))
    launch(project.id, { id, projectId: project.id, title, dir }, { type: 'shell' })
  }

  const editOnOpen = useRef(new Set<string>())

  const resumeTab = (projectId: string, tab: Extract<Tab, { kind: 'terminal' }>, emptyShell: boolean): void => {
    const how: Launch = !emptyShell && tab.agent ? { type: 'resume', agent: tab.agent } : { type: 'shell' }
    launch(projectId, { id: tab.id, projectId, title: tab.title, ...(tab.dir ? { dir: tab.dir } : {}) }, how)
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

  const focusSeq = useRef(0)
  const openFile = (project: Project, path: string, opts?: OpenFileOptions): string => {
    const request = { projectId: project.id, path, viewer: viewerFor(path), preview: opts?.preview === true }
    const { id } = placeFileTab(tabs[project.id] ?? [], request, isDirty)
    const focusRequest = { n: ++focusSeq.current, focus: opts?.focus !== false }
    setTabs((prev) => ({
      ...prev,
      [project.id]: placeFileTab(prev[project.id] ?? [], request, isDirty).list.map((t) =>
        t.id === id && t.kind === 'file' ? { ...t, focusRequest } : t
      )
    }))
    selectTab(project.id, id)
    return id
  }

  // "Comparar com selecionado" da árvore: o primeiro escolhido fica à esquerda, como no VS Code.
  const openCompare = (project: Project, left: string, right: string): void => {
    if (left === right) return
    const request = { projectId: project.id, left, right }
    const { id } = placeCompareTab(tabs[project.id] ?? [], request)
    setTabs((prev) => ({ ...prev, [project.id]: placeCompareTab(prev[project.id] ?? [], request).list }))
    selectTab(project.id, id)
  }

  const pinTab = (tabId: string): void => patchFile(tabId, { preview: false })

  const openDiff = (project: Project, path: string, staged: boolean, opts: GitDiffOpen = {}): void => {
    const { preview = false, ...rest } = opts
    const request = { projectId: project.id, path, target: { ...rest, staged }, preview }
    const { id } = placeDiffTab(tabs[project.id] ?? [], request, isDirty)
    setTabs((prev) => ({ ...prev, [project.id]: placeDiffTab(prev[project.id] ?? [], request, isDirty).list }))
    selectTab(project.id, id)
  }

  const movePathInTabs = (projectId: string, from: string, to: string): void => {
    setTabs((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).map((t) => (t.kind === 'file' ? moveFileTab(t, from, to) : t))
    }))
    setRecentFiles((prev) => (prev[projectId] ? { ...prev, [projectId]: moveRecentPaths(prev[projectId], from, to) } : prev))
  }

  const forgetRecent = (projectId: string, gone: readonly string[]): void =>
    setRecentFiles((prev) => (prev[projectId] ? { ...prev, [projectId]: prev[projectId].filter((p) => !gone.includes(p)) } : prev))

  const hasUnsavedUnder = (projectId: string, rel: string): boolean =>
    (tabs[projectId] ?? []).some((t) => t.kind === 'file' && isDirty(t) && tabShowsPathUnder(t, rel))

  // show: o pedido veio de "Revelar na árvore" e o painel precisa voltar para Arquivos; abrir pelo terminal, pela busca
  // ou pelo Ctrl+P só marca o item, sem tirar o painel da aba em que está.
  const [reveal, setReveal] = useState<{ path: string; n: number; show?: boolean } | null>(null)
  const [searchRequested, setSearchRequested] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== 'KeyF') return
      // No terminal a tecla é do processo que roda nele.
      if (document.activeElement instanceof Element && document.activeElement.closest('.xterm')) return
      e.preventDefault()
      e.stopPropagation()
      setRightPanelOpen((open) => {
        if (!open) {
          try {
            localStorage.setItem(RIGHT_PANEL_KEY, '1')
          } catch {
            // preferência só não fica lembrada
          }
        }
        return true
      })
      setSearchRequested(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Abre o arquivo, mostra onde ele está na árvore (expandindo as pastas) e, se veio com :linha, vai até ela.
  // preview: clique simples num resultado da busca, como no VS Code; terminal e Ctrl+P abrem a aba fixa.
  // column/length: a ocorrência da busca, que o editor seleciona.
  const openFromTerminal = (projectId: string, rel: string, line: number | null, opts?: OpenAtOptions): void => {
    const project = state?.projects.find((p) => p.id === projectId)
    if (!project) return
    const id = openFile(project, rel, opts)
    setReveal((r) => ({ path: rel, n: (r?.n ?? 0) + 1 }))
    if (line) {
      const n = Date.now()
      const jump = {
        line,
        n,
        ...(opts?.column !== undefined ? { column: opts.column } : {}),
        ...(opts?.length !== undefined ? { length: opts.length } : {})
      }
      setTabs((prev) => ({
        ...prev,
        [projectId]: (prev[projectId] ?? []).map((t) => (t.id === id && t.kind === 'file' ? { ...t, jump } : t))
      }))
    }
  }

  const revealInTree = (path: string): void => {
    if (!rightPanelOpen) toggleRightPanel()
    setReveal((r) => ({ path, n: (r?.n ?? 0) + 1, show: true }))
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

  const closedTabs = useRef<Record<string, ClosedFileTab[]>>({})

  const reopenLastClosed = (projectId: string): void => {
    const reopened = reopenClosed(tabsRef.current[projectId] ?? [], closedTabs.current[projectId] ?? [])
    if (!reopened) return
    closedTabs.current[projectId] = reopened.history
    setTabs((prev) => ({ ...prev, [projectId]: reopened.list }))
    selectTab(projectId, reopened.id)
  }

  // Pelo teclado vale a aba ativa do projeto, como o editor ativo no VS Code.
  useTabShortcuts((command: TabCommand) => {
    const projectId = selectedId
    if (!projectId) return
    const list = tabs[projectId] ?? []
    const tab = list.find((t) => t.id === activeTab[projectId])
    const closeScope = (scope: CloseScope): void =>
      void closeTabs(projectId, fileTabsToClose(tabsRef.current[projectId] ?? [], tab?.id ?? '', scope, isDirty), tab?.id)
    switch (command) {
      case 'close':
        return void closeActiveTab(projectId, tab)
      case 'closeAll':
        return closeScope('all')
      case 'closeSaved':
        return closeScope('saved')
      case 'reopenClosed':
        return reopenLastClosed(projectId)
      case 'nextFile':
      case 'previousFile': {
        const next = siblingFileTab(list, tab?.id, command === 'nextFile' ? 1 : -1)
        if (next) selectTab(projectId, next)
        return
      }
    }
    if (tab?.kind !== 'file') return
    const projectPath = state?.projects.find((p) => p.id === projectId)?.path ?? ''
    switch (command) {
      case 'keepOpen':
        return pinTab(tab.id)
      case 'copyPath':
        return void copyPath(`${projectPath}\\${tab.path}`).then(() => flash('Caminho copiado'))
      case 'copyRelativePath':
        return void copyPath(tab.path).then(() => flash('Caminho relativo copiado'))
      case 'revealInExplorer':
        if (!tab.deleted) void window.kora.revealInExplorer(projectId, tab.path)
        return
    }
  })

  // Pelo atalho a aba some sem o mouse ter apontado para ela: terminal rodando pede confirmação (Enter aceita).
  const closeActiveTab = async (projectId: string, tab: Tab | undefined): Promise<void> => {
    if (!tab) return
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
  }

  // Abre a edição do nome na barra de cima e na lateral, com o mesmo rascunho nos dois campos.
  useRenameTabShortcut(() => {
    const tab = selectedId ? (tabs[selectedId] ?? []).find((t) => t.id === activeTab[selectedId]) : undefined
    if (tab?.kind === 'terminal') setLinkedRename({ tabId: tab.id, title: tab.title, draft: tab.title })
  })

  const shownFile = selectedId ? (tabs[selectedId] ?? []).find((t) => t.id === activeTab[selectedId]) : undefined
  // A aba riscada (arquivo apagado por fora) não volta para os recentes do Ctrl+P.
  const shownFilePath = shownFile?.kind === 'file' && !shownFile.diff && !shownFile.compare && !shownFile.deleted ? shownFile.path : null
  useEffect(() => {
    if (!selectedId || !shownFilePath) return
    setRecentFiles((prev) => {
      const list = prev[selectedId] ?? []
      if (list[0] === shownFilePath) return prev
      return { ...prev, [selectedId]: [shownFilePath, ...list.filter((p) => p !== shownFilePath)].slice(0, 30) }
    })
  }, [selectedId, shownFilePath])

  useQuickOpenShortcut(() => {
    if (selectedId && !missing.has(selectedId)) setQuickOpen(true)
  })

  // Trocar de aba sem tirar o foco do campo (ex.: pelo celular) não dispara o blur; a edição some como a de um campo só.
  const currentTabId = selectedId ? activeTab[selectedId] : undefined
  useEffect(() => {
    setLinkedRename((r) => (r && r.tabId !== currentTabId ? null : r))
  }, [currentTabId])

  // Várias abas de uma vez (menu "Fechar outras", "Fechar todas"...): cada arquivo não salvo passa pela mesma
  // pergunta, mostrado na tela; Cancelar ou salvamento que falha desiste do lote inteiro. A lista é relida a cada
  // passo porque a pergunta espera o usuário e as abas podem mudar no meio.
  const closeTabs = async (projectId: string, ids: string[], keepActive?: string): Promise<void> => {
    for (const tabId of ids) {
      const tab = (tabsRef.current[projectId] ?? []).find((t) => t.id === tabId)
      if (tab?.kind !== 'file' || !isDirty(tab)) continue
      if (ids.length > 1) selectTab(projectId, tabId)
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
    const gone = new Set(ids)
    for (const tab of tabsRef.current[projectId] ?? []) {
      if (!gone.has(tab.id) || tab.kind !== 'terminal' || !tab.live) continue
      window.kora.killTerminal(tab.id)
      terminalBus.forget(tab.id)
    }
    closedTabs.current[projectId] = rememberClosed(closedTabs.current[projectId] ?? [], tabsRef.current[projectId] ?? [], ids)
    const remaining = (tabsRef.current[projectId] ?? []).filter((t) => !gone.has(t.id))
    const fallback = remaining.some((t) => t.id === keepActive) ? keepActive : remaining.at(-1)?.id
    setTabs((prev) => ({ ...prev, [projectId]: (prev[projectId] ?? []).filter((t) => !gone.has(t.id)) }))
    setActiveTab((prev) => (prev[projectId] && gone.has(prev[projectId]) ? { ...prev, [projectId]: fallback } : prev))
  }

  const closeTab = (projectId: string, tabId: string): Promise<void> => closeTabs(projectId, [tabId])

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

  const renameProject = (id: string, name: string): void => {
    window.kora.renameProject(id, name).then(setState, (err: unknown) => setError(ipcErrorMessage(err)))
  }

  const setProjectCollapsed = (id: string, collapsed: boolean): void => {
    window.kora.setProjectCollapsed(id, collapsed).then(setState, (err: unknown) => setError(ipcErrorMessage(err)))
  }

  const relocateProject = (project: Project): void => {
    window.kora.relocateProject(project.id).then(
      (next) => {
        setState(next)
        setError(null)
        checkMissing()
      },
      (err: unknown) => setError(ipcErrorMessage(err))
    )
  }

  const removeProject = async (project: Project): Promise<void> => {
    const open = tabs[project.id] ?? []
    const running = open.filter((t) => t.kind === 'terminal' && t.live).length
    const ok = await confirm({
      title: `Remover "${project.name}" da lista?`,
      message: (
        <>
          <p>
            {missing.has(project.id)
              ? 'A pasta não foi encontrada no computador; só o vínculo com o Kora é desfeito.'
              : 'A pasta e os arquivos continuam no computador; só o vínculo com o Kora é desfeito.'}
          </p>
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
    saveScrollbackNow(tabId)
    window.kora.killTerminal(tabId)
    terminalBus.forget(tabId)
    patchTerminal(tabId, { live: false })
  }

  const tabMenuItems = (projectId: string, tab: Tab, where: TabPlace): MenuItem[] => {
    const close: MenuItem = {
      label: 'Fechar aba',
      icon: <Icon name="fechar" />,
      danger: true,
      shortcut: TAB_SHORTCUT_LABEL.close,
      onSelect: () => void closeTab(projectId, tab.id)
    }
    if (tab.kind === 'file') {
      const projectPath = state?.projects.find((p) => p.id === projectId)?.path ?? ''
      const closeScope = (scope: CloseScope): void =>
        void closeTabs(projectId, fileTabsToClose(tabsRef.current[projectId] ?? [], tab.id, scope, isDirty), tab.id)
      const keep: MenuItem[] = tab.preview
        ? [{ label: 'Manter aberta', icon: <Icon name="fixar" />, shortcut: TAB_SHORTCUT_LABEL.keepOpen, onSelect: () => pinTab(tab.id) }, 'separator']
        : []
      const onDisk: MenuItem[] = tab.deleted
        ? []
        : [
            { label: 'Revelar na árvore', icon: <Icon name="arquivo" />, onSelect: () => revealInTree(tab.path) },
            {
              label: 'Mostrar no Explorer',
              icon: <Icon name="pastaAberta" />,
              shortcut: TAB_SHORTCUT_LABEL.revealInExplorer,
              onSelect: () => void window.kora.revealInExplorer(projectId, tab.path)
            }
          ]
      return [
        ...keep,
        {
          label: 'Copiar caminho',
          icon: <Icon name="copiar" />,
          shortcut: TAB_SHORTCUT_LABEL.copyPath,
          onSelect: () => void copyPath(`${projectPath}\\${tab.path}`)
        },
        {
          label: 'Copiar caminho relativo',
          icon: <Icon name="copiar" />,
          shortcut: TAB_SHORTCUT_LABEL.copyRelativePath,
          onSelect: () => void copyPath(tab.path)
        },
        ...onDisk,
        'separator',
        { label: 'Fechar', icon: <Icon name="fechar" />, shortcut: TAB_SHORTCUT_LABEL.close, onSelect: () => void closeTab(projectId, tab.id) },
        { label: 'Fechar outras', onSelect: () => closeScope('others') },
        { label: 'Fechar à direita', onSelect: () => closeScope('right') },
        { label: 'Fechar salvas', shortcut: TAB_SHORTCUT_LABEL.closeSaved, onSelect: () => closeScope('saved') },
        { label: 'Fechar todas', shortcut: TAB_SHORTCUT_LABEL.closeAll, onSelect: () => closeScope('all') }
      ]
    }
    const items: MenuItem[] = [
      {
        label: 'Renomear',
        icon: <Icon name="editar" />,
        shortcut: 'F2',
        onSelect: () => setRenameRequest((r) => ({ tabId: tab.id, where, n: (r?.n ?? 0) + 1 }))
      }
    ]
    if (tab.live) {
      items.push({
        label: tab.agent ? 'Suspender sessão' : 'Encerrar terminal',
        icon: <Icon name={tab.agent ? 'pausar' : 'parar'} />,
        onSelect: () => suspendTab(tab.id)
      })
    } else if (tab.agent) {
      items.push({ label: 'Continuar chat', icon: <Icon name="retomar" />, onSelect: () => resumeTab(projectId, tab, false) })
    } else {
      items.push({ label: 'Abrir terminal', icon: <Icon name="terminal" />, onSelect: () => resumeTab(projectId, tab, true) })
    }
    if (tab.agent) {
      const sessionId = tab.agent.sessionId
      items.push({
        label: 'Copiar ID da sessão',
        icon: <Icon name="copiar" />,
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
  const shownTab = selected ? projectTabs.find((t) => t.id === activeTab[selected.id]) : undefined
  const activeTerminal = shownTab?.kind === 'terminal' ? shownTab : undefined

  const linkedRenameValue: LinkedRename | null = linkedRename && {
    tabId: linkedRename.tabId,
    draft: linkedRename.draft,
    onChange: (draft) => setLinkedRename((r) => r && { ...r, draft }),
    onFinish: (commit) => {
      const name = linkedRename.draft.trim()
      if (commit && name !== linkedRename.title) renameTab(linkedRename.tabId, name)
      setLinkedRename(null)
    }
  }

  return (
    <LinkedRenameContext.Provider value={linkedRenameValue}>
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
          onPinTab={(_projectId, tabId) => pinTab(tabId)}
          renameRequest={renameRequest?.where === 'side' ? renameRequest : null}
          onNewTab={newTab}
          onAdd={() => void addProject()}
          onRemove={(p) => void removeProject(p)}
          onRenameProject={renameProject}
          onSetProjectCollapsed={setProjectCollapsed}
          missing={missing}
          onRelocate={relocateProject}
          onArrangeProject={arrangeProject}
          zoom={state.settings.zoom}
          terminalFontSize={state.settings.terminalFontSize}
          fileFontSize={state.settings.fileFontSize}
          onZoom={onZoom}
          onTerminalFont={onTerminalFont}
          onFileFont={onFileFont}
          onReorderTab={reorderTab}
          update={update}
          onInstallUpdate={installUpdate}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenMobile={() => setMobileOpen(true)}
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
            onPin={pinTab}
            onQuickOpen={selected && !missing.has(selected.id) ? () => setQuickOpen(true) : undefined}
          />
          {error && (
            <div className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</div>
          )}
          {recoveryNotice && (
            <div className="flex items-start justify-between gap-3 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              <span className="min-w-0 break-words">{recoveryNotice}</span>
              <button type="button" className="shrink-0 underline" onClick={() => setRecoveryNotice(null)}>Entendi</button>
            </div>
          )}

          {tabMemory.notice && (
            <div className="flex items-start justify-between gap-3 border-b bg-[#e2c08d]/10 px-3 py-1.5 text-xs text-[#895503] dark:text-[#e2c08d]">
              <span className="min-w-0 break-words">{tabMemory.notice}</span>
              <button type="button" className="shrink-0 underline" onClick={tabMemory.dismissNotice}>Entendi</button>
            </div>
          )}

          <div className="relative flex-1 bg-canvas">
            {Object.entries(tabs).flatMap(([projectId, list]) =>
              list.map(guarded((tab) => projectId === selectedId && activeTab[projectId] === tab.id && !missing.has(projectId), (tab) => {
                const visible = projectId === selectedId && activeTab[projectId] === tab.id && !missing.has(projectId)
                // Descarregada por falta de memória: o visualizador sai da árvore e relê do disco quando a aba voltar.
                if (tab.kind === 'file' && !visible && tabMemory.unloaded.has(tab.id)) return <div key={`${tab.id}:unloaded`} className="absolute inset-0 invisible" />
                if (tab.kind === 'file') {
                  const projectPath = state.projects.find((p) => p.id === projectId)?.path ?? ''
                  if (tab.compare) {
                    return (
                      <Suspense key={`${tab.id}:compare`} fallback={<div className="absolute inset-0 bg-canvas" />}>
                        <CompareView
                          projectId={projectId}
                          projectPath={projectPath}
                          left={tab.compare.left}
                          right={tab.path}
                          visible={visible}
                          fontSize={state.settings.fileFontSize}
                          wordWrap={state.settings.fileWordWrap}
                          onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                          onSaveHandle={(save) => (save ? fileSavers.current.set(tab.id, save) : fileSavers.current.delete(tab.id))}
                          onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        />
                      </Suspense>
                    )
                  }
                  if (tab.diff) {
                    return (
                      <Suspense key={`${tab.id}:diff`} fallback={<div className="absolute inset-0 bg-canvas" />}>
                        <DiffView
                          projectId={projectId}
                          projectPath={projectPath}
                          path={tab.path}
                          target={tab.diff}
                          visible={visible}
                          fontSize={state.settings.fileFontSize}
                          wordWrap={state.settings.fileWordWrap}
                          onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        />
                      </Suspense>
                    )
                  }
                  if (tab.viewer === 'pdf') {
                    return (
                      <PdfView
                        key={tab.id}
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                      />
                    )
                  }
                  if (tab.viewer === 'sheet') {
                    const sheetMode: SheetMode = isTextSheet(tab.path) && tab.editing ? 'text' : 'sheet'
                    const setSheetMode = (mode: SheetMode): void => patchFile(tab.id, { editing: mode === 'text' })
                    return (
                      <SheetTab
                        key={`${tab.id}:sheet`}
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible}
                        mode={sheetMode}
                        dirty={tab.dirty}
                        jump={tab.jump}
                        onModeChange={setSheetMode}
                        onSave={() => void fileSavers.current.get(tab.id)?.()}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        editor={
                          isTextSheet(tab.path) && (sheetMode === 'text' || tab.dirty) ? (
                            <Suspense key={`${tab.id}:edit`} fallback={<div className="absolute inset-0 bg-canvas" />}>
                              <CodeView
                                projectId={projectId}
                                projectPath={projectPath}
                                path={tab.path}
                                visible={visible && sheetMode === 'text'}
                                fontSize={state.settings.fileFontSize}
                                wordWrap={state.settings.fileWordWrap}
                                onWordWrapChange={(on) => void window.kora.setFileWordWrap(on).then(setState)}
                                onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                                onSaveHandle={(save) => (save ? fileSavers.current.set(tab.id, save) : fileSavers.current.delete(tab.id))}
                                jump={tab.jump}
                                focusRequest={tab.focusRequest}
                                onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                                headerExtra={<SheetModeToggle mode={sheetMode} onChange={setSheetMode} />}
                              />
                            </Suspense>
                          ) : null
                        }
                      />
                    )
                  }
                  const svgMode: 'preview' | 'edit' | null =
                    !isSvg(tab.path) ? null : tab.viewer === 'image' ? 'preview' : tab.viewer === 'code' ? 'edit' : null
                  if (tab.viewer === 'image' && svgMode === null) {
                    return (
                      <ImageView
                        key={tab.id}
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        onOpenAsText={() => patchFile(tab.id, { viewer: 'code', editing: true })}
                      />
                    )
                  }
                  if (tab.viewer === 'media') {
                    return (
                      <MediaView
                        key={tab.id}
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                      />
                    )
                  }
                  if (tab.viewer === 'notebook') {
                    return (
                      <NotebookView
                        key={tab.id}
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        onOpenAsText={() => patchFile(tab.id, { viewer: 'code', editing: true })}
                      />
                    )
                  }
                  if (tab.viewer === 'external') {
                    return (
                      <ExternalView
                        key={tab.id}
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        onOpenAsText={() => patchFile(tab.id, { viewer: 'code', editing: true })}
                      />
                    )
                  }
                  const mdMode: MarkdownMode | null =
                    tab.viewer !== 'markdown' ? null : tab.split ? 'split' : tab.editing ? 'edit' : 'preview'
                  const setMdMode = (mode: MarkdownMode): void =>
                    patchFile(tab.id, { editing: mode !== 'preview', split: mode === 'split' })
                  const setSvgMode = (mode: MarkdownMode): void =>
                    patchFile(tab.id, { viewer: mode === 'preview' ? 'image' : 'code', editing: mode !== 'preview' })
                  const saveTab = (): void => void fileSavers.current.get(tab.id)?.()
                  const codeView = (
                    <Suspense key={`${tab.id}:edit`} fallback={<div className="absolute inset-0 bg-canvas" />}>
                      <CodeView
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible && mdMode !== 'preview' && svgMode !== 'preview'}
                        fontSize={state.settings.fileFontSize}
                        wordWrap={state.settings.fileWordWrap}
                        onWordWrapChange={(on) => void window.kora.setFileWordWrap(on).then(setState)}
                        onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                        onSaveHandle={(save) => (save ? fileSavers.current.set(tab.id, save) : fileSavers.current.delete(tab.id))}
                        jump={tab.jump}
                        focusRequest={tab.focusRequest}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        headerExtra={
                          mdMode ? (
                            <ModeToggle mode={mdMode} compact={mdMode === 'split'} onChange={setMdMode} />
                          ) : (
                            svgMode && <ModeToggle mode={svgMode} modes={SVG_MODES} onChange={setSvgMode} />
                          )
                        }
                      />
                    </Suspense>
                  )
                  if (svgMode !== null) {
                    return (
                      <SvgTab
                        key={`${tab.id}:svg`}
                        projectId={projectId}
                        projectPath={projectPath}
                        path={tab.path}
                        visible={visible}
                        mode={svgMode}
                        dirty={tab.dirty}
                        onModeChange={setSvgMode}
                        onSave={saveTab}
                        onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                        editor={svgMode === 'edit' || tab.dirty ? codeView : null}
                      />
                    )
                  }
                  if (mdMode === null) return codeView
                  return (
                    <MarkdownTab
                      key={`${tab.id}:markdown`}
                      projectId={projectId}
                      projectPath={projectPath}
                      path={tab.path}
                      visible={visible}
                      fontSize={state.settings.fileFontSize}
                      mode={mdMode}
                      dirty={tab.dirty}
                      onModeChange={setMdMode}
                      onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                      editor={mdMode !== 'preview' || tab.dirty ? codeView : null}
                      onSave={saveTab}
                    />
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
                    reattach={reattached.current.has(tab.id)}
                    fontSize={state.settings.terminalFontSize}
                    projectId={projectId}
                    onOpenPath={(rel, line) => openFromTerminal(projectId, rel, line)}
                  />
                )
              }))
            )}

            {selected && missing.has(selected.id) && (
              <EmptyState
                ring={rings}
                title={`A pasta de "${selected.name}" não foi encontrada`}
                detail={selected.path}
                note="Ela foi movida, renomeada ou apagada fora do Kora. Se ela mudou de lugar, localize a pasta nova: abas, categoria e nome continuam."
                actions={[
                  { label: 'Localizar pasta…', onClick: () => relocateProject(selected) },
                  { label: 'Remover da lista', onClick: () => void removeProject(selected) }
                ]}
              />
            )}
            {selected && !missing.has(selected.id) && projectTabs.length === 0 && (
              <EmptyState
                ring={rings}
                title={selected.name}
                detail={selected.path}
                actions={[
                  { label: 'Claude', onClick: () => newTab(selected, 'claude') },
                  { label: 'Codex', onClick: () => newTab(selected, 'codex') },
                  { label: 'OpenCode', onClick: () => newTab(selected, 'opencode') },
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
            {quickOpen && selected && !missing.has(selected.id) && (
              <QuickOpen
                key={selected.id}
                projectId={selected.id}
                recent={recentFiles[selected.id] ?? NO_RECENT}
                onMissing={(gone) => forgetRecent(selected.id, gone)}
                onOpen={(rel, line) => {
                  setQuickOpen(false)
                  openFromTerminal(selected.id, rel, line)
                }}
                onClose={() => setQuickOpen(false)}
              />
            )}
          </div>
        </main>

        {rightPanelOpen && selected && (
          <RightPanel
            key={`${selected.id}:${selected.path}`}
            project={selected}
            missing={missing.has(selected.id)}
            openSessions={
              new Map(
                projectTabs.flatMap((t) =>
                  t.kind === 'terminal' && t.agent ? [[t.agent.sessionId, t.titleLocked ? t.title : null] as const] : []
                )
              )
            }
            onOpenFile={(path: string, opts?: OpenFileOptions) => openFile(selected, path, opts)}
            onOpenAt={(rel: string, line: number | null, opts?: OpenAtOptions) => openFromTerminal(selected.id, rel, line, opts)}
            onOpenDiff={(path: string, staged: boolean, opts?: GitDiffOpen) => openDiff(selected, path, staged, opts)}
            onCompare={(left: string, right: string) => openCompare(selected, left, right)}
            onOpenTerminal={(dir: string) => openTerminalIn(selected, dir)}
            commitDraft={commitDrafts[selected.id] ?? ''}
            onCommitDraftChange={(update) =>
              setCommitDrafts((drafts) => ({ ...drafts, [selected.id]: update(drafts[selected.id] ?? '') }))
            }
            onOpenSession={(session) => openSession(selected, session, true)}
            onPinSession={(session) => openSession(selected, session, false)}
            onOpenWorktree={(path) => void openWorktree(path)}
            onPathMoved={(from, to) => movePathInTabs(selected.id, from, to)}
            hasUnsavedUnder={(rel) => hasUnsavedUnder(selected.id, rel)}
            reveal={reveal}
            onRevealShown={() => setReveal((r) => (r ? { ...r, show: false } : r))}
            searchRequested={searchRequested}
            onSearchShown={() => setSearchRequested(false)}
            activeAgent={activeTerminal?.agent ?? null}
            activeActivity={activeTerminal?.live ? (activeTerminal.activity ?? null) : null}
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

        {mobileOpen && <MobileDialog onClose={closeMobile} />}
        {settingsOpen && (
          <SettingsDialog
            onOpenMobile={() => {
              setSettingsOpen(false)
              setMobileOpen(true)
            }}
            version={appVersion}
            update={update}
            installing={installing}
            onCheck={() => void window.kora.checkUpdate()}
            onInstall={() => void installUpdate()}
            onClose={closeSettings}
            theme={state.settings.theme}
            onSetTheme={(theme) => void window.kora.setTheme(theme).then(setState)}
            alerts={state.settings.alerts}
            onAlertsChange={(alerts) => void window.kora.setAlerts(alerts).then(setState)}
            onPreviewSound={playChime}
            support={{
              errors: errorSummary,
              copyRecent: async () => navigator.clipboard.writeText(await window.kora.recentErrors()),
              saveFile: () => window.kora.saveDiagnostic(),
              openFolder: () => window.kora.openLogsFolder(),
              clear: async () => setErrorSummary(await window.kora.clearErrors())
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
    </LinkedRenameContext.Provider>
  )
}

function EmptyState(props: {
  title: string
  detail: string
  note?: string
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
      {props.note && <p className="max-w-md text-xs text-muted-foreground">{props.note}</p>}
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {props.actions.map((a, i) => (
          <Button key={a.label} variant={i === 0 ? 'primary' : 'secondary'} onClick={a.onClick}>
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
