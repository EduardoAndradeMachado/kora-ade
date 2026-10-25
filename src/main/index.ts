import { basename, dirname, join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, shell, Tray } from 'electron'
import { is } from '@electron-toolkit/utils'
import { loadState, saveState } from './store'
import { addProject, applyLayout, forgetSessionName, mergeTabs, missingProjectIds, namedSessions, relocateProject, removeProject, renameProject, setProjectCollapsed, setTabAgent } from './projects'
import { Terminals } from './terminals'
import { MobileServer } from './mobile-server'
import { MobileRuntime } from './mobile-runtime'
import { createTranscriber } from './transcriber'
import { DESKTOP } from './terminal-sizes'
import { Scrollbacks } from './scrollback'
import { ConflictError, importEntries, listDir, moveEntry, readText, resolveInside, writeText } from './files'
import { AgentDetector, UNREADABLE } from './agent-detect'
import { createRolloutFinder, FolderWatch, isClaudeTranscript } from './agent-watch'
import { listProjectSessions, sessionArtifacts } from './sessions'
import { dayMetrics, sessionMetrics, type MetricsSources } from './metrics'
import { deleteOpencodeSession, newOpencodeSessionId, opencodeActivity, opencodeDbPath } from './opencode'
import { createEntry, openInDefaultBrowser, renameEntry } from './file-actions'
import { ProjectIcons } from './project-icons'
import { savePastedImage } from './pasted-image'
import { createUsageReader } from './usage'
import { ClaudeAccounts } from './claude-accounts'
import { KillOnCloseJob } from './job-object'
import { ProcessRegistry, type Survivor } from './process-registry'
import { ProjectWatchers } from './project-watcher'
import { createLagMonitor } from './lag-monitor'
import { autoUpdater } from 'electron-updater'
import { createErrorLog, errorText } from './error-log'
import { startUpdates, type Updates } from './updater'
import type { UpdateStatus } from '../shared/update'
import type { MobileStatus } from '../shared/mobile'
import { resolveTerminalLink } from './terminal-links'
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitIgnored,
  gitInit,
  gitPull,
  gitPush,
  gitRemoteUrl,
  gitSetRemote,
  gitStage,
  gitStatus,
  gitSync,
  gitUnstage,
  gitWorktrees
} from './git'
import { KORA_FILE_PRIVILEGED_SCHEMES, registerKoraFileProtocol } from './file-protocol'
import { fileHolders, listProcesses, withCreationTime } from './processes'
import { AlertsSchema, FILE_FONT, ProjectGroupSchema, TERMINAL_FONT, ThemePreferenceSchema, ZOOM, type KoraState } from '../shared/state'
import { z } from 'zod'
import { AgentRefSchema, AgentSessionSchema, type AgentActivity, type AgentSession, type Startup } from '../shared/agent'
import type { CloseKind, CreateResult, Launch, SaveResult, TabRef } from '../shared/ipc'

// A detecção roda quando as pastas dos agentes mudam; a volta periódica só cobre o que não deixa rastro
// em arquivo (ex.: o dono de um lock do Codex encerrar sem apagar o lock).
const DETECT_FALLBACK_MS = 30_000
const DETECT_MIN_GAP_MS = 400
// O token OAuth do Claude é lido aqui dentro e nunca vai para o renderer; só os percentuais saem.
const usageCacheFile = (): string => join(app.getPath('userData'), 'usage-cache.json')
const usage = createUsageReader({
  claudeRoot: join(homedir(), '.claude'),
  codexRoot: join(homedir(), '.codex'),
  cache: {
    load: () => JSON.parse(readFileSync(usageCacheFile(), 'utf8')),
    save: (slots) => writeFileSync(usageCacheFile(), JSON.stringify(slots), 'utf8')
  },
  onClaudeUsage: (accessToken, windows) => {
    claudeAccounts?.recordUsage(accessToken, windows).catch(() => {})
  }
})
let projectIcons: ProjectIcons
let claudeAccounts: ClaudeAccounts
// Pega as renovações que o Claude Code faz a cada ~8 h: a cópia da conta ativa no cofre fica sempre a mais nova.
const CLAUDE_ACCOUNTS_SYNC_MS = 60_000

let mainWindow: BrowserWindow | null = null
let state: KoraState
let stateFile: string
let scrollbacks: Scrollbacks | undefined

// Job Object: se o Kora morrer à força, o Windows encerra os shells (e o Claude/Codex dentro deles).
// Registro: rede de segurança para o que escapar do job; os sobreviventes são mostrados ao abrir.
let job: KillOnCloseJob | null = null
let registry: ProcessRegistry | null = null
let survivors = new Map<string, Survivor>()

function registerLaunch(tabId: string, pid: number): void {
  const tab = state.tabs.find((t) => t.id === tabId)
  registry?.add({
    pid,
    tabId,
    projectId: tab?.projectId ?? '',
    title: tab?.title ?? 'Terminal',
    agentKind: tab?.agent?.kind ?? null
  })
}

let mobileServer: MobileServer | null = null
let mobileRuntime: MobileRuntime | null = null

// Só para mudanças feitas pelo celular: as do PC já estão na interface que as fez.
function mobileChanged(): void {
  mobileServer?.publishState()
  if (mobileRuntime) mainWindow?.webContents.send('mobile:state', { state, tabs: mobileRuntime.snapshot().tabs })
}

const terminals = new Terminals({
  onData: (id, data, sequence) => {
    mainWindow?.webContents.send('terminal:data', id, data, sequence)
    mobileServer?.publishData(id, data, sequence)
  },
  onExit: (id, exitCode, pid) => {
    registry?.remove(pid)
    activities.delete(id)
    mainWindow?.webContents.send('terminal:exit', id, exitCode)
    mobileServer?.publishState()
  },
  onSpawn: (id, pid) => {
    job?.assign(pid)
    registerLaunch(id, pid)
  }
})

// Apagar a pasta do projeto com o app aberto nem sempre derruba o watcher: às vezes só chegam os eventos
// dos arquivos de dentro. Sem a raiz, o aviso vira "releia tudo", que faz a interface conferir as pastas.
const watchers = new ProjectWatchers((projectId, change) => {
  const project = state.projects.find((p) => p.id === projectId)
  const gone = project !== undefined && !isDirectory(project.path)
  if (gone) watchers.unwatch(projectId)
  mainWindow?.webContents.send('fs:changed', projectId, gone ? { ...change, rescan: true } : change)
  if (gone) mobileServer?.publishState()
})

const agentDirs = {
  claudeSessions: join(homedir(), '.claude', 'sessions'),
  codexLocks: join(homedir(), '.codex', 'thread-writer-locks'),
  codexRollouts: join(homedir(), '.codex', 'sessions'),
  claudeProjects: join(homedir(), '.claude', 'projects'),
  // Banco do OpenCode v2: conversas e estado dos turnos. Lido só para títulos, datas e atividade.
  opencodeDb: opencodeDbPath()
}
const codexRollout = createRolloutFinder(agentDirs.codexRollouts)
const detector = new AgentDetector({
  claudeSessionsDir: agentDirs.claudeSessions,
  codexLocksDir: agentDirs.codexLocks,
  listProcesses,
  creationTime: (p) => withCreationTime(p).createdMs,
  lockHolders: fileHolders,
  codexRollout
})
const metricsSources: MetricsSources = {
  claudeRoot: join(homedir(), '.claude'),
  codexSessions: agentDirs.codexRollouts,
  codexRollout,
  opencodeDb: agentDirs.opencodeDb
}
const agentFolders = new FolderWatch(
  [
    { dir: agentDirs.claudeSessions, recursive: false },
    { dir: agentDirs.codexLocks, recursive: false },
    { dir: agentDirs.codexRollouts, recursive: true },
    // Com subagente em segundo plano, o fim do turno só aparece no transcript; o arquivo do pid segue "busy".
    { dir: agentDirs.claudeProjects, recursive: true, accept: isClaudeTranscript },
    // O OpenCode grava cada evento do turno no WAL do SQLite; o banco em si muda ao abrir/fechar.
    ...(agentDirs.opencodeDb
      ? [
          {
            dir: dirname(agentDirs.opencodeDb),
            recursive: false,
            accept: (name: string) =>
              name === basename(agentDirs.opencodeDb) || name.startsWith(`${basename(agentDirs.opencodeDb)}-`)
          }
        ]
      : [])
  ],
  () => scheduleDetect()
)

function commit(next: KoraState): KoraState {
  saveState(stateFile, next)
  state = next
  mobileServer?.publishState()
  return state
}

// Histórico de terminal é um arquivo por aba: quando a aba sai do estado (fechou de verdade, projeto
// removido), o arquivo sai junto. Roda depois de gravar as abas, nunca antes.
function pruneScrollbacks(): void {
  scrollbacks?.prune(state.tabs.map((t) => t.id))
}

const sameAgent = (a: AgentSession | null, b: AgentSession | null): boolean =>
  a?.kind === b?.kind && a?.sessionId === b?.sessionId && a?.name === b?.name

function bindAgent(tabId: string, agent: AgentSession | null): void {
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab || sameAgent(tab.agent, agent)) return
  commit(setTabAgent(state, tabId, agent))
  const pid = terminals.pids().get(tabId)
  if (pid) registerLaunch(tabId, pid)
  mainWindow?.webContents.send('tab:agent', tabId, agent)
}

const LAG_LOG_MAX_BYTES = 1_000_000
function lagLog(line: string): void {
  try {
    const file = join(app.getPath('userData'), 'lag.log')
    if (existsSync(file) && statSync(file).size > LAG_LOG_MAX_BYTES) writeFileSync(file, '')
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    // Diagnóstico não pode derrubar o app.
  }
}
let lag: ReturnType<typeof createLagMonitor> | null = null
let updates: Updates | null = null

function updaterLog(line: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'updater.log'), `${new Date().toISOString()} ${line}${String.fromCharCode(10)}`, 'utf8')
  } catch {
    // Diagnóstico não pode derrubar o app.
  }
}

// Todo canal de IPC passa a deixar rastro no monitor de travamento: quando o main congelar, o lag.log diz o que rodava.
function traceIpc(): void {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) =>
    handle(channel, (...args) => {
      lag?.note(channel)
      return listener(...args)
    })
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = ((channel: string, listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void) =>
    on(channel, (event, ...args) => {
      lag?.note(channel)
      listener(event, ...args)
    })) as typeof ipcMain.on
}

const activities = new Map<string, AgentActivity | null>()

function setActivity(tabId: string, activity: AgentActivity | null): void {
  if ((activities.get(tabId) ?? null) === activity) return
  activities.set(tabId, activity)
  mainWindow?.webContents.send('tab:activity', tabId, activity)
  mobileServer?.publishState()
}

function detectAgents(): void {
  lag?.note('detectar-sessoes')
  const pids = terminals.pids()
  if (pids.size === 0) return
  // Aba do OpenCode já nasce vinculada ao ID que a CLI recebeu; o detector não a enxerga, e zerar a atividade
  // dela a cada volta apagaria o "trabalhando" de que o aviso de fim de turno depende.
  const opencodeTabs = state.tabs.flatMap((tab) =>
    tab.agent?.kind === 'opencode' && pids.has(tab.id) ? [{ id: tab.id, sessionId: tab.agent.sessionId }] : []
  )
  const opencodeIds = new Set(opencodeTabs.map((tab) => tab.id))
  try {
    const found = detector.detect(pids)
    for (const [tabId, detected] of found) if (detected !== UNREADABLE) bindAgent(tabId, detected.agent)
    for (const tabId of pids.keys()) {
      if (opencodeIds.has(tabId)) continue
      const detected = found.get(tabId)
      if (detected !== UNREADABLE) setActivity(tabId, detected?.activity ?? null)
    }
  } catch (err) {
    console.error('[kora] falha ao detectar sessões', err)
  }
  for (const tab of opencodeTabs) {
    const activity = opencodeActivity(agentDirs.opencodeDb, tab.sessionId)
    if (activity !== undefined) setActivity(tab.id, activity)
  }
}

// O Codex grava o rollout sem parar enquanto trabalha: no máximo uma detecção a cada DETECT_MIN_GAP_MS,
// sempre com uma última depois da rajada para o estado final não se perder.
let detectTimer: NodeJS.Timeout | undefined
let lastDetect = 0
function scheduleDetect(): void {
  if (detectTimer) return
  detectTimer = setTimeout(
    () => {
      detectTimer = undefined
      lastDetect = Date.now()
      detectAgents()
    },
    Math.max(0, lastDetect + DETECT_MIN_GAP_MS - Date.now())
  )
}

// A barra nativa do Windows sai; ficam só os botões de janela sobre o canto direito, na altura das
// linhas do topo da interface (h-10 = 40 px no zoom 1). As cores acompanham o fundo de cada tema.
const TOP_ROW_PX = 40
// Até a interface carregar vale o tema do Windows; depois ela informa o tema que de fato desenhou.
let rendererDark: boolean | null = null
// Com diálogo aberto a página fica sob um véu preto a 50%; os botões de janela recebem a mesma mistura.
let windowDimmed = false
const DIM_ALPHA = 0.5
const dim = (hex: string): string =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - DIM_ALPHA)).toString(16).padStart(2, '0')).join('')}`

function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = rendererDark ?? nativeTheme.shouldUseDarkColors
  const color = dark ? '#16171b' : '#f6f7f9'
  const symbolColor = dark ? '#eceef2' : '#15171b'
  return {
    color: windowDimmed ? dim(color) : color,
    symbolColor: windowDimmed ? dim(symbolColor) : symbolColor,
    height: Math.round(TOP_ROW_PX * state.settings.zoom)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Kora ADE',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    icon: join(app.getAppPath(), 'resources', 'icon.ico'),
    // Mesma cor do fundo do tema ativo: evita o clarão de outra cor enquanto a interface carrega.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171b' : '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      // O visualizador de PDF do Chromium só carrega em iframe com plugins ligados.
      plugins: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // O zoom do Chromium é por origem e se perde no reload; reaplica o salvo a cada carregamento.
  mainWindow.webContents.on('did-finish-load', () => mainWindow?.webContents.setZoomFactor(state.settings.zoom))
  // X da janela vai para a bandeja: os processos das abas são encerrados (libera a memória, como "Suspender")
  // e as abas ficam com "Continuar chat". Sair de verdade só pelo menu da bandeja. Sem bandeja o X encerra,
  // e aí quem pergunta pelos arquivos não salvos é este handler (o before-quit só vem depois da janela fechar).
  mainWindow.on('close', (event) => {
    detectAgents()
    if (quitting) return
    if (!tray) {
      if (!unsaved || quitConfirmed) return
      event.preventDefault()
      askRenderer('quit')
      return
    }
    event.preventDefault()
    if (unsaved) askRenderer('hide')
    else hideToTray()
  })
  mainWindow.on('closed', () => {
    terminals.killAll()
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  // Um reload da interface descarta as abas; sem isso os shells (e um Claude rodando) ficariam órfãos no main.
  // Só a navegação da página principal: iframe (o visualizador de PDF) também dispara did-start-loading, e abrir
  // um PDF encerrava todos os terminais.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    terminals.killAll()
    activities.clear()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const vitrine = process.env['KORA_VITRINE'] === '1' ? '#vitrine' : ''
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + vitrine)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Antes de encerrar os processos (esconder, sair, instalar), a interface grava o buffer das abas vivas.
// Interface travada não segura o fechamento para sempre: depois do prazo o caminho segue sem o histórico.
const FLUSH_TIMEOUT_MS = 1500
let flushScrollbackDone: (() => void) | null = null
let flushScrollbackTimer: NodeJS.Timeout | undefined
let afterFlushScrollback: (() => void)[] = []

function requestScrollbackFlush(next: () => void): void {
  const contents = mainWindow?.webContents
  if (!contents || contents.isDestroyed()) {
    next()
    return
  }
  afterFlushScrollback.push(next)
  if (flushScrollbackDone) return
  flushScrollbackDone = () => {
    clearTimeout(flushScrollbackTimer)
    flushScrollbackTimer = undefined
    flushScrollbackDone = null
    const callbacks = afterFlushScrollback
    afterFlushScrollback = []
    for (const callback of callbacks) callback()
  }
  flushScrollbackTimer = setTimeout(flushScrollbackDone, FLUSH_TIMEOUT_MS)
  contents.send('terminal:flush-scrollback')
}

function hideToTray(): void {
  requestScrollbackFlush(() => {
    terminals.killAll()
    mainWindow?.hide()
    mainWindow?.webContents.send('app:hidden')
  })
}

// Arquivo com alteração não salva: o fechamento espera a interface perguntar (salvar, descartar ou cancelar).
// Interface travada não responde nem o recebimento; aí o fechamento segue, para o app nunca ficar sem saída.
const CLOSE_ACK_MS = 3000
let unsaved = false
let quitConfirmed = false
let closeAckTimer: NodeJS.Timeout | undefined

function proceedClose(kind: CloseKind): void {
  if (kind === 'hide') {
    hideToTray()
    return
  }
  quitConfirmed = true
  app.quit()
}

function askRenderer(kind: CloseKind): void {
  showWindow()
  clearTimeout(closeAckTimer)
  closeAckTimer = setTimeout(() => proceedClose(kind), CLOSE_ACK_MS)
  mainWindow?.webContents.send('app:close-requested', kind)
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function projectRoot(id: string): string {
  const project = state.projects.find((p) => p.id === id)
  if (!project) throw new Error(`Projeto desconhecido: ${id}`)
  return project.path
}

// O vínculo manual pode chegar antes do save debounced do renderer; a aba entra no estado aqui.
function ensureTab(tab: TabRef): void {
  projectRoot(tab.projectId)
  if (!state.tabs.some((t) => t.id === tab.id)) {
    commit({ ...state, tabs: [...state.tabs, { ...tab, titleLocked: tab.titleLocked ?? false, agent: null }] })
  }
}

function launchTerminal(tab: TabRef, cols: number, rows: number, launch: Launch): void {
  const cwd = projectRoot(tab.projectId)
  ensureTab(tab)
  let startup: Startup | undefined
  if (launch.type === 'claude') {
    const sessionId = randomUUID()
    startup = { kind: 'claude', mode: 'new', sessionId }
    bindAgent(tab.id, { kind: 'claude', sessionId })
  } else if (launch.type === 'codex') {
    startup = { kind: 'codex', mode: 'new' }
  } else if (launch.type === 'opencode') {
    // A CLI cria a conversa no primeiro pedido com este mesmo ID; a aba já fica vinculada.
    const sessionId = newOpencodeSessionId()
    startup = { kind: 'opencode', mode: 'new', sessionId }
    bindAgent(tab.id, { kind: 'opencode', sessionId })
  } else if (launch.type === 'resume') {
    const agent = AgentSessionSchema.parse(launch.agent)
    startup = { kind: agent.kind, mode: 'resume', sessionId: agent.sessionId }
  }
  // A interface pode achar que a aba está adormecida enquanto o pty antigo ainda vive
  // (ex.: renderer recarregado); o pedido novo substitui o antigo em vez de falhar.
  terminals.kill(tab.id)
  terminals.spawn(tab.id, cwd, cols, rows, startup)
}

// Com a conexão ligada o main mantém a cópia das telas; desligada, o custo de interpretar a saída some.
async function setMobileEnabled(enabled: boolean): Promise<MobileStatus> {
  const server = mobileServer!
  if (!enabled) {
    const status = await server.stop()
    terminals.setMirroring(false)
    return status
  }
  terminals.setMirroring(true)
  try {
    return await server.start()
  } catch (err) {
    terminals.setMirroring(false)
    throw err
  }
}

function registerIpc(): void {
  ipcMain.on('runtime:windows-build', (event) => {
    event.returnValue = Number(release().split('.')[2]) || 0
  })
  ipcMain.handle('state:get', () => state)
  // O renderer segue o prefers-color-scheme, que o Chromium deriva do nativeTheme.themeSource.
  const SizesSchema = z.object({
    zoom: z.number().min(ZOOM.min).max(ZOOM.max).optional(),
    terminalFontSize: z.number().int().min(TERMINAL_FONT.min).max(TERMINAL_FONT.max).optional(),
    fileFontSize: z.number().int().min(FILE_FONT.min).max(FILE_FONT.max).optional()
  })
  const LayoutSchema = z.object({
    groups: z.array(ProjectGroupSchema),
    placements: z.array(z.object({ id: z.string().min(1), hidden: z.boolean(), groupId: z.string().min(1).nullable() }))
  })
  ipcMain.handle('settings:sizes', (_e, sizes: unknown) => {
    const next = SizesSchema.parse(sizes)
    const committed = commit({ ...state, settings: { ...state.settings, ...next } })
    if (next.zoom !== undefined) {
      mainWindow?.webContents.setZoomFactor(next.zoom)
      mainWindow?.setTitleBarOverlay(titleBarOverlay())
    }
    return committed
  })
  ipcMain.handle('settings:theme', (_e, theme: unknown) => {
    const next = ThemePreferenceSchema.parse(theme)
    nativeTheme.themeSource = next
    return commit({ ...state, settings: { ...state.settings, theme: next } })
  })

  ipcMain.handle('project:add', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Adicionar projeto',
      properties: ['openDirectory']
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return state
    return commit(addProject(state, path))
  })

  ipcMain.handle('project:add-path', (_e, path: string) => {
    if (typeof path !== 'string' || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`Pasta não encontrada: ${path}`)
    }
    return commit(addProject(state, path))
  })

  ipcMain.handle('project:remove', (_e, id: string) => {
    for (const tab of state.tabs.filter((t) => t.projectId === id)) terminals.kill(tab.id)
    watchers.unwatch(id)
    const next = commit(removeProject(state, id))
    pruneScrollbacks()
    return next
  })

  ipcMain.handle('project:missing', () => missingProjectIds(state, isDirectory))

  ipcMain.handle('project:relocate', async (_e, id: string) => {
    const old = projectRoot(String(id))
    let near = dirname(old)
    while (!isDirectory(near) && dirname(near) !== near) near = dirname(near)
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Localizar a pasta do projeto',
      defaultPath: isDirectory(near) ? near : undefined,
      properties: ['openDirectory']
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return state
    const next = commit(relocateProject(state, String(id), path))
    watchers.unwatch(String(id))
    await projectIcons.refresh(String(id), path).catch(() => null)
    return next
  })

  ipcMain.handle('project:rename', (_e, id: string, name: string) => commit(renameProject(state, String(id), String(name))))
  ipcMain.handle('project:collapse', (_e, id: string, collapsed: boolean) =>
    commit(setProjectCollapsed(state, String(id), collapsed === true))
  )

  ipcMain.handle('project:layout', (_e, layout: unknown) => commit(applyLayout(state, LayoutSchema.parse(layout))))

  ipcMain.handle('fs:list', (_e, id: string, rel: string) => {
    const root = projectRoot(id)
    const entries = listDir(root, rel)
    watchers.watch(id, root)
    return entries
  })
  ipcMain.handle('fs:read', (_e, id: string, rel: string) => readText(projectRoot(id), rel))
  ipcMain.handle(
    'fs:write',
    (_e, id: string, rel: string, content: string, expectedMtimeMs: number): SaveResult => {
      try {
        return { ok: true, mtimeMs: writeText(projectRoot(id), rel, content, expectedMtimeMs) }
      } catch (err) {
        return { ok: false, conflict: err instanceof ConflictError, message: (err as Error).message }
      }
    }
  )
  ipcMain.handle('fs:open', async (_e, id: string, rel: string) => {
    const error = await shell.openPath(resolveInside(projectRoot(id), rel))
    if (error) throw new Error(error)
  })

  ipcMain.handle(
    'fs:create',
    (_e, id: string, parentRel: string, name: string, kind: 'file' | 'dir'): CreateResult => {
      try {
        return { ok: true, rel: createEntry(projectRoot(id), parentRel, name, kind) }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )
  ipcMain.handle('settings:alerts', (_e, alerts: unknown) =>
    commit({ ...state, settings: { ...state.settings, alerts: AlertsSchema.parse(alerts) } })
  )
  ipcMain.handle('settings:word-wrap', (_e, on: unknown) =>
    commit({ ...state, settings: { ...state.settings, fileWordWrap: z.boolean().parse(on) } })
  )
  ipcMain.on('window:focus', () => showWindow())
  ipcMain.on('errors:report', (_e, text: unknown) => errorLog.record('interface', String(text)))
  ipcMain.handle('errors:summary', () => errorLog.summary())
  ipcMain.handle('errors:clear', () => {
    errorLog.clear()
    return errorLog.summary()
  })
  // Cabe numa mensagem de chat ou num e-mail; o arquivo completo sai pelo "Salvar arquivo".
  ipcMain.handle('errors:recent', () => errorLog.recent(8000))
  // A pasta só nasce no primeiro erro gravado; sem nenhum erro ainda, o Explorer recebia um caminho inexistente.
  ipcMain.handle('errors:open-folder', async () => {
    const folder = dirname(errorLog.file)
    mkdirSync(folder, { recursive: true })
    const error = await shell.openPath(folder)
    if (error) throw new Error(`Não foi possível abrir a pasta dos logs (${folder}): ${error}`)
  })
  ipcMain.handle('errors:save', async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
    // getPath('downloads') lança quando a pasta conhecida não existe ou não resolve; aí o diálogo abre na pasta do usuário.
    let folder: string
    try {
      folder = app.getPath('downloads')
    } catch {
      folder = homedir()
    }
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Salvar arquivo de diagnóstico',
      defaultPath: join(folder, `kora-diagnostico-${stamp}.txt`),
      filters: [{ name: 'Texto', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return null
    const env = {
      'Versão do Kora': app.getVersion(),
      Instalado: app.isPackaged ? 'sim' : 'não (desenvolvimento)',
      Windows: `${release()} (${process.arch})`,
      Electron: process.versions.electron ?? '',
      Chrome: process.versions.chrome ?? '',
      Node: process.versions.node,
      'Gerado em': new Date().toISOString()
    }
    const userData = app.getPath('userData')
    writeFileSync(
      result.filePath,
      errorLog.diagnostic(env, [
        { name: 'Travamentos (lag.log)', file: join(userData, 'lag.log') },
        { name: 'Atualização (updater.log)', file: join(userData, 'updater.log') }
      ]),
      'utf8'
    )
    return result.filePath
  })
  ipcMain.on('window:dimmed', (_e, dimmed: unknown) => {
    windowDimmed = dimmed === true
    mainWindow?.setTitleBarOverlay(titleBarOverlay())
  })
  ipcMain.on('window:dark', (_e, dark: unknown) => {
    rendererDark = dark === true
    mainWindow?.setTitleBarOverlay(titleBarOverlay())
  })
  ipcMain.handle('update:status', (): UpdateStatus => updates?.status() ?? { state: 'disabled' })
  ipcMain.handle('update:check', () => updates?.check())
  ipcMain.handle('update:install', () => updates?.install() ?? false)
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('terminal:resolve-link', (_e, id: string, text: string) => resolveTerminalLink(projectRoot(id), String(text)))
  ipcMain.on('diag:long-task', (_e, ms: number) => lagLog(`${new Date().toISOString()} interface travada ${Math.round(Number(ms))} ms`))
  ipcMain.handle('fs:move', (_e, id: string, fromRel: string, toDirRel: string) =>
    moveEntry(projectRoot(id), String(fromRel), String(toDirRel))
  )
  ipcMain.handle('fs:import', (_e, id: string, sources: unknown, toDirRel: string) =>
    importEntries(projectRoot(id), z.array(z.string().min(1)).parse(sources), String(toDirRel))
  )
  ipcMain.handle('fs:rename', (_e, id: string, rel: string, name: string) =>
    renameEntry(projectRoot(id), String(rel), String(name))
  )
  ipcMain.handle('fs:reveal', async (_e, id: string, rel: string) => {
    const target = resolveInside(projectRoot(id), rel)
    if (!rel || statSync(target).isDirectory()) {
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    } else {
      shell.showItemInFolder(target)
    }
  })
  // Vai para a Lixeira em vez de apagar: um clique errado no explorador tem volta.
  ipcMain.handle('fs:trash', async (_e, id: string, rel: string) => {
    if (!rel) throw new Error('A pasta do projeto não pode ser excluída por aqui.')
    await shell.trashItem(resolveInside(projectRoot(id), rel))
  })
  ipcMain.handle('fs:open-browser', (_e, id: string, rel: string) =>
    openInDefaultBrowser(resolveInside(projectRoot(id), rel))
  )

  ipcMain.handle('project:icon', (_e, id: string) => projectIcons.get(id, projectRoot(id)))
  ipcMain.handle('project:icon-refresh', (_e, id: string) => projectIcons.refresh(id, projectRoot(id)))

  ipcMain.handle('git:status', (_e, id: string) => gitStatus(projectRoot(id)))
  ipcMain.handle('git:branches', (_e, id: string) => gitBranches(projectRoot(id)))
  ipcMain.handle('git:worktrees', (_e, id: string) => gitWorktrees(projectRoot(id)))
  ipcMain.handle('git:init', (_e, id: string) => gitInit(projectRoot(id)))
  ipcMain.handle('git:remote-url', (_e, id: string) => gitRemoteUrl(projectRoot(id)))
  ipcMain.handle('git:set-remote', (_e, id: string, url: string) => gitSetRemote(projectRoot(id), String(url)))
  ipcMain.handle('git:create-branch', (_e, id: string, name: string, checkout: boolean) =>
    gitCreateBranch(projectRoot(id), String(name), checkout === true)
  )
  ipcMain.handle('git:checkout', (_e, id: string, name: string, remote: string | null) =>
    gitCheckout(projectRoot(id), String(name), typeof remote === 'string' ? remote : null)
  )
  ipcMain.handle('git:ignored', async (_e, id: string, relPaths: string[]) =>
    [...(await gitIgnored(projectRoot(id), Array.isArray(relPaths) ? relPaths.map(String) : []))]
  )
  const pathList = (paths: unknown): string[] => (Array.isArray(paths) ? paths.map(String) : [])
  ipcMain.handle('git:stage', (_e, id: string, paths: unknown) => gitStage(projectRoot(id), pathList(paths)))
  ipcMain.handle('git:unstage', (_e, id: string, paths: unknown) => gitUnstage(projectRoot(id), pathList(paths)))
  // Não rastreado descartado vai para a Lixeira, como o excluir do explorador.
  ipcMain.handle('git:discard', (_e, id: string, paths: unknown) =>
    gitDiscard(projectRoot(id), pathList(paths), (abs) => shell.trashItem(abs))
  )
  ipcMain.handle('git:diff', (_e, id: string, rel: string, staged: boolean) => gitDiff(projectRoot(id), String(rel), staged === true))
  ipcMain.handle('git:commit', (_e, id: string, message: string, stageAll: boolean) =>
    gitCommit(projectRoot(id), String(message), stageAll === true)
  )
  ipcMain.handle('git:push', (_e, id: string) => gitPush(projectRoot(id)))
  ipcMain.handle('git:pull', (_e, id: string) => gitPull(projectRoot(id)))
  ipcMain.handle('git:fetch', (_e, id: string) => gitFetch(projectRoot(id)))
  ipcMain.handle('git:sync', (_e, id: string) => gitSync(projectRoot(id)))

  ipcMain.handle('usage:read', () => usage.read())
  ipcMain.handle('claude-accounts:list', () => claudeAccounts.list())
  ipcMain.handle('claude-accounts:switch', async (_e, id: string) => {
    const view = await claudeAccounts.switchTo(String(id))
    usage.forget('claude')
    return view
  })
  ipcMain.handle('claude-accounts:remove', (_e, id: string) => claudeAccounts.remove(String(id)))
  ipcMain.handle('claude-accounts:login', (_e, email: unknown) =>
    claudeAccounts.startLogin(typeof email === 'string' ? email : undefined)
  )
  ipcMain.on('claude-accounts:login-code', (_e, code: unknown) => claudeAccounts.loginCode(String(code)))
  ipcMain.on('claude-accounts:login-cancel', () => claudeAccounts.cancelLogin())
  ipcMain.on('claude-accounts:login-dismiss', () => claudeAccounts.dismissLogin())

  ipcMain.handle('orphans:list', () =>
    [...survivors.values()].map((s) => ({
      key: s.key,
      title: s.entry.title,
      project: state.projects.find((p) => p.id === s.entry.projectId)?.name ?? 'projeto removido',
      agent: s.entry.agentKind,
      memoryMb: Math.round(s.memoryBytes / 1048576),
      processCount: s.processes.length
    }))
  )
  ipcMain.handle('orphans:kill', (_e, key: string) => {
    const s = survivors.get(key)
    if (s) registry?.killTree(s)
    survivors.delete(key)
  })
  ipcMain.handle('orphans:kill-all', () => {
    for (const s of survivors.values()) registry?.killTree(s)
    survivors.clear()
  })
  ipcMain.handle('orphans:keep', () => {
    for (const s of survivors.values()) registry?.forget(s)
    survivors.clear()
  })

  ipcMain.handle('sessions:list', async (_e, projectId: string) =>
    namedSessions(
      state,
      await listProjectSessions(
        join(homedir(), '.claude'),
        join(homedir(), '.codex'),
        projectRoot(projectId),
        agentDirs.opencodeDb
      )
    )
  )

  ipcMain.handle('metrics:session', (_e, projectId: string, agent: unknown) =>
    sessionMetrics(metricsSources, AgentRefSchema.parse(agent), projectRoot(projectId))
  )
  ipcMain.handle('metrics:day', (_e, since: unknown) => dayMetrics(metricsSources, z.number().finite().parse(since)))

  // Conversa ligada a uma aba (rodando ou adormecida) não é apagada: o "Continuar" dela passaria a falhar.
  ipcMain.handle('sessions:delete', async (_e, projectId: string, session: unknown) => {
    const { kind, sessionId } = AgentRefSchema.parse(session)
    const bound = state.tabs.find((t) => t.agent?.sessionId === sessionId)
    if (bound) throw new Error(`Essa conversa está na aba "${bound.title}". Feche a aba antes de apagar.`)
    if (kind === 'opencode') {
      await deleteOpencodeSession(sessionId, projectRoot(projectId))
      commit(forgetSessionName(state, { kind, sessionId }))
      return
    }
    const files = await sessionArtifacts(kind, sessionId, projectRoot(projectId), {
      claudeRoot: join(homedir(), '.claude'),
      codexRoot: join(homedir(), '.codex')
    })
    if (files.length === 0) throw new Error('Conversa não encontrada no disco.')
    for (const file of files) await shell.trashItem(file)
    commit(forgetSessionName(state, { kind, sessionId }))
  })

  ipcMain.on('app:unsaved', (_e, value: unknown) => {
    unsaved = value === true
  })
  ipcMain.on('app:close-ack', () => clearTimeout(closeAckTimer))
  ipcMain.on('app:close-answer', (_e, kind: unknown, answer: unknown) => {
    if ((kind === 'hide' || kind === 'quit') && answer === 'proceed') proceedClose(kind)
  })

  ipcMain.on('tabs:save-sync', (event, tabs: TabRef[], baseline?: TabRef[]) => {
    commit(mergeTabs(state, tabs, baseline))
    pruneScrollbacks()
    event.returnValue = true
  })
  ipcMain.handle('tabs:save', (_e, tabs: TabRef[], baseline?: TabRef[]) => {
    commit(mergeTabs(state, tabs, baseline))
    pruneScrollbacks()
  })

  ipcMain.handle('tab:set-agent', (_e, tab: TabRef, agent: unknown) => {
    ensureTab(tab)
    bindAgent(tab.id, agent === null ? null : AgentSessionSchema.parse(agent))
  })

  ipcMain.handle('terminal:spawn', (_e, tab: TabRef, cols: number, rows: number, launch: Launch) => {
    launchTerminal(tab, cols, rows, launch)
    mobileRuntime!.launched(tab.id, DESKTOP, { cols, rows })
  })
  ipcMain.handle('clipboard:save-image', (_e, bytes: Uint8Array, mime: string) =>
    savePastedImage(join(app.getPath('temp'), 'kora-paste'), bytes, mime)
  )
  ipcMain.on('terminal:write', (_e, id: string, data: string) => terminals.write(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    mobileRuntime!.desktopSize(id, { cols, rows })
  )
  ipcMain.on('terminal:take', (_e, id: string) => mobileRuntime!.desktopTake(id))
  ipcMain.handle('terminal:snapshot', async (_e, id: unknown) => {
    const key = String(id)
    const snapshot = await terminals.snapshot(key)
    const size = mobileRuntime!.sizes.current(key)
    return { snapshot, size: size ? { id: key, ...size } : null }
  })
  ipcMain.on('terminal:kill', (_e, id: string) => terminals.kill(id))
  ipcMain.handle('mobile:status', () => mobileServer!.status())
  ipcMain.handle('mobile:enabled', (_e, enabled: unknown) => setMobileEnabled(z.boolean().parse(enabled)))
  ipcMain.handle('mobile:pair', () => mobileServer!.invite())
  ipcMain.handle('mobile:revoke', (_e, id: unknown) => mobileServer!.revoke(String(id)))
  ipcMain.handle('mobile:rename', (_e, id: unknown, name: unknown) => mobileServer!.rename(String(id), String(name)))
  ipcMain.handle('terminal:scrollback-save', (_e, id: unknown, text: unknown) => {
    const key = String(id)
    // Save atrasado de aba já removida não pode ressuscitar o arquivo que o prune acabou de apagar.
    if (!state.tabs.some((t) => t.id === key)) return
    scrollbacks?.save(key, String(text))
  })
  ipcMain.handle('terminal:scrollback-load', (_e, id: unknown) => scrollbacks?.load(String(id)) ?? null)
  ipcMain.on('terminal:scrollback-flushed', () => flushScrollbackDone?.())
}

protocol.registerSchemesAsPrivileged(KORA_FILE_PRIVILEGED_SCHEMES)

// Testes de ponta a ponta sobem uma instância isolada: estado, ícones e trava de instância única
// ficam na pasta indicada, sem encostar no Kora que o usuário está usando.
// A instância de desenvolvimento tem dados próprios: assim roda ao lado da instalada sem disputar o estado nem a trava de instância única.
if (process.env['KORA_USER_DATA']) app.setPath('userData', process.env['KORA_USER_DATA'])
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Kora ADE Dev'))

// Log de erros para suporte, ligado antes de tudo: o console.error dos módulos, exceção não tratada, promessa
// rejeitada sem tratamento e processo que cai viram entradas no errors.log. Nada sai do computador sozinho.
const errorLog = createErrorLog({ dir: join(app.getPath('userData'), 'logs') })
const consoleError = console.error.bind(console)
console.error = (...args: unknown[]) => {
  consoleError(...args)
  errorLog.record('main', args.map(errorText).join(' '))
}
// Com o handler o Electron não mostra mais o diálogo nativo de erro; a interface avisa que ficou registrado.
process.on('uncaughtException', (err) => {
  errorLog.record('main', err, 'exceção não tratada')
  mainWindow?.webContents.send('app:error')
})
process.on('unhandledRejection', (reason) => errorLog.record('main', reason, 'promessa rejeitada sem tratamento'))
app.on('render-process-gone', (_e, _contents, details) =>
  errorLog.record('processo', `interface caiu: ${details.reason} (código ${details.exitCode})`)
)
app.on('child-process-gone', (_e, details) => {
  if (details.reason === 'clean-exit') return
  errorLog.record('processo', `${details.type} caiu: ${details.reason} (código ${details.exitCode})`)
})

// Duas instâncias gravariam o mesmo kora-state.json e uma apagaria os projetos da outra.
if (!app.requestSingleInstanceLock()) app.quit()

let quitting = false
let flushedOnQuit = false
let tray: Tray | null = null
app.on('before-quit', (event) => {
  if (unsaved && !quitConfirmed && mainWindow) {
    event.preventDefault()
    askRenderer('quit')
    return
  }
  // Sair também passa pelo mesmo flush do esconder: o que estava na tela vira o histórico da próxima abertura.
  // Instalação de atualização já gravou antes de matar os processos e não pode ser segurada aqui.
  if (!flushedOnQuit && !quitting && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault()
    requestScrollbackFlush(() => {
      flushedOnQuit = true
      app.quit()
    })
    return
  }
  quitting = true
})

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// Sem bandeja o X volta a encerrar o app: pior, mas nada mais depende dela.
function createTray(): void {
  try {
    tray = new Tray(join(app.getAppPath(), 'resources', 'icon.ico'))
  } catch (err) {
    console.error('[kora] bandeja indisponível', err)
    return
  }
  tray.setToolTip('Kora ADE')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Kora', click: showWindow },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() }
    ])
  )
  tray.on('click', showWindow)
}

app.on('second-instance', showWindow)
nativeTheme.on('updated', () => mainWindow?.setTitleBarOverlay(titleBarOverlay()))

void app.whenReady().then(() => {
  stateFile = join(app.getPath('userData'), 'kora-state.json')
  state = loadState(stateFile)
  scrollbacks = new Scrollbacks(join(app.getPath('userData'), 'scrollback'))
  pruneScrollbacks()
  job = new KillOnCloseJob()
  registry = new ProcessRegistry(join(app.getPath('userData'), 'processes.json'))
  survivors = new Map(registry.findSurvivors().map((s) => [s.key, s]))
  nativeTheme.themeSource = state.settings.theme
  registerKoraFileProtocol(projectRoot)
  projectIcons = new ProjectIcons(join(app.getPath('userData'), 'icons'))
  claudeAccounts = new ClaudeAccounts({
    claudeRoot: join(homedir(), '.claude'),
    globalConfigFile: join(homedir(), '.claude.json'),
    vaultFile: join(app.getPath('userData'), 'claude-accounts.json'),
    scratchDir: app.getPath('userData'),
    // DPAPI do Windows: só o mesmo usuário nesta máquina abre os logins guardados.
    secrets: {
      encrypt: (plain) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Criptografia do Windows indisponível; o Kora não guarda logins sem ela')
        return safeStorage.encryptString(plain).toString('base64')
      },
      decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    },
    onChange: () => mainWindow?.webContents.send('claude-accounts:changed')
  })
  setInterval(() => {
    claudeAccounts
      .sync()
      .then((changed) => {
        if (changed) mainWindow?.webContents.send('claude-accounts:changed')
      })
      .catch(() => {})
  }, CLAUDE_ACCOUNTS_SYNC_MS)
  // O menu padrão do Electron traz Ctrl+W (fecha a janela) e Ctrl+R (recarrega a interface e derruba os
  // terminais); os atalhos do Kora ficam todos na interface.
  Menu.setApplicationMenu(null)
  lag = createLagMonitor({ intervalMs: 100, thresholdMs: 300, write: lagLog })
  traceIpc()
  registerIpc()
  mobileRuntime = new MobileRuntime({
    state: () => state,
    commit,
    terminals,
    activities,
    launch: launchTerminal,
    changed: mobileChanged,
    sized: (id, change) => {
      mainWindow?.webContents.send('terminal:size', { id, ...change })
      mobileServer?.publishSize({ id, ...change })
    },
    icon: (id, path) => projectIcons.get(id, path),
    usage: () => usage.read(),
    accounts: () => claudeAccounts.list(),
    switchAccount: async (id) => {
      await claudeAccounts.switchTo(id)
      usage.forget('claude')
    },
    relocated: async (id, path) => {
      watchers.unwatch(id)
      await projectIcons.refresh(id, path).catch(() => null)
      mainWindow?.webContents.send('fs:changed', id, { dirs: [], files: [], allFiles: true, git: true, ignoreRules: true, rescan: true })
    }
  })
  mobileServer = new MobileServer({
    configFile: join(app.getPath('userData'), 'mobile.json'),
    rendererDir: join(__dirname, '../renderer'),
    devUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    devAssetRoots: [join(app.getAppPath(), 'node_modules'), join(app.getAppPath(), 'src/shared')],
    androidDir: join(app.getAppPath(), 'resources', 'android'),
    imageDir: join(app.getPath('temp'), 'kora-paste'),
    audioDir: join(app.getPath('temp'), 'kora-audio'),
    transcribe: createTranscriber(),
    pdfjsDir: is.dev ? join(app.getAppPath(), 'node_modules', 'pdfjs-dist') : join(app.getAppPath(), 'resources', 'pdfjs'),
    edition: is.dev ? 'dev' : 'prod',
    // Porta própria no Dev: com o Kora instalado aberto, os dois ficam ligados ao celular ao mesmo tempo.
    port: is.dev ? 43128 : 43127,
    runtime: mobileRuntime,
    changed: mobileChanged,
    statusChanged: (status) => mainWindow?.webContents.send('mobile:status', status)
  })
  setInterval(detectAgents, DETECT_FALLBACK_MS)
  agentFolders.start()
  createWindow()
  createTray()
  if (mobileServer.pairing.enabled) void setMobileEnabled(true).catch((err) => console.error('[kora] conexão com o celular', err))
  // KORA_UPDATE_FEED aponta para um servidor local nos testes de atualização; o normal são as Releases do GitHub.
  const feed = process.env['KORA_UPDATE_FEED']
  if (app.isPackaged) {
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    updates = startUpdates({
      source: autoUpdater,
      onStatus: (status) => mainWindow?.webContents.send('update:status', status),
      beforeInstall: () => {
        quitting = true
        detectAgents()
        terminals.killAll()
      },
      log: updaterLog
    })
  }
})

app.on('window-all-closed', () => {
  terminals.killAll()
  app.quit()
})
