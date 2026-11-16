import { basename, dirname, join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, release, totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, powerSaveBlocker, protocol, safeStorage, screen, shell, Tray } from 'electron'
import { minWindowSize } from './window-size'
import { is } from '@electron-toolkit/utils'
import { isReadOnly, loadState, recoveryMessage, saveState } from './store'
import { addProject, applyLayout, forgetSessionName, mergeTabs, missingProjectIds, namedSessions, relocateProject, removeProject, renameProject, setProjectCollapsed, setTabAgent } from './projects'
import { terminalCwd, Terminals } from './terminals'
import { MobileServer } from './mobile-server'
import { MobileRuntime } from './mobile-runtime'
import { createTranscriber, transcriberInstalled } from './transcriber'
import { DESKTOP } from './terminal-sizes'
import { Scrollbacks } from './scrollback'
import { ConflictError, copyEntries, importEntries, listDir, moveEntry, readText, resolveInside, writeText } from './files'
import { latestSearch, listProjectFiles, normalizeSearchOptions } from './project-files'
import { readSheetBytes } from './xlsx'
import { AgentDetector, UNREADABLE } from './agent-detect'
import { createRolloutFinder, FolderWatch, isClaudeTranscript } from './agent-watch'
import { listProjectSessions, sessionArtifacts } from './sessions'
import { dayMetrics, sessionMetrics, type MetricsSources } from './metrics'
import { deleteOpencodeSession, newOpencodeSessionId, opencodeActivity, opencodeDataDir, opencodeDbPath } from './opencode'
import { createEntry, openInDefaultBrowser, renameEntry, trashEntry, treeStamp, TreeUndoStepSchema, undoTreeStep } from './file-actions'
import { ProjectIcons } from './project-icons'
import { savePastedImage } from './pasted-image'
import { createUsageReader } from './usage'
import { antigravitySource } from './antigravity'
import { ClaudeAccounts } from './claude-accounts'
import { KillOnCloseJob } from './job-object'
import { ProcessRegistry, type Survivor } from './process-registry'
import { ProjectWatchers } from './project-watcher'
import { createLagMonitor } from './lag-monitor'
import { autoUpdater } from 'electron-updater'
import { createErrorLog, errorText } from './error-log'
import { startUpdates, type Updates } from './updater'
import { rememberLiveTabs, takeLiveTabs } from './resume-after-update'
import { CRASH_RELOADS_PER_WINDOW, crashNotice, decideCrashReload } from './crash-reload'
import { fileSizes, rendererMemoryMB, softLimitMB, startMemoryWatch } from './memory-watch'
import type { MemoryUsage } from '../shared/open-limits'
import { reattachPlan } from './terminal-reattach'
import { releaseStuckDrag } from './stuck-drag'
import type { UpdateStatus } from '../shared/update'
import { AccountActionSchema, AdminRequestSchema, type AccountAction, type MobileStatus } from '../shared/mobile'
import { accountClient } from './remote/account'
import { resolveTerminalLink } from './terminal-links'
import { nameArg, numberArg, pathArg, pathListArg, textArg } from './ipc-args'
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
import {
  gitAbortOperation,
  gitContinueOperation,
  gitResolve,
  gitStashApply,
  gitStashDrop,
  gitStashFiles,
  gitStashList,
  gitStashPush
} from './git'
import type { GitCheckoutMode, GitDeletionChoice, GitPullStrategy, GitStashRef } from '../shared/git-types'
import { gitCommitAmend, gitCommitDiff, gitCommitFiles, gitFileAt, gitHeadCommit, gitLog, gitUndoLastCommit } from './git-history'
import { gitDeleteBranch, gitPublishBranch, gitRenameBranch } from './git-branch-actions'
import { gitAddToIgnore } from './git-ignore'
import { gitApplyHunk, gitHunks } from './git-hunks'
import { KORA_FILE_PRIVILEGED_SCHEMES, registerKoraFileProtocol } from './file-protocol'
import { defaultAppFor } from './file-assoc'
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
const resumeFile = (): string => join(app.getPath('userData'), 'resume-after-update.json')
const usage = createUsageReader({
  claudeRoot: join(homedir(), '.claude'),
  codexRoot: join(homedir(), '.codex'),
  opencode: { dbFile: opencodeDbPath(), dataDir: opencodeDataDir() },
  antigravity: antigravitySource,
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
let recoveryNotice: string | null = null
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
  mobileServer?.publishFiles({ projectId, dirs: change.dirs, git: change.git, rescan: gone || change.rescan, files: change.files, allFiles: change.allFiles })
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
  const before = state.tabs
  saveState(stateFile, next)
  state = next
  // Sessão que não grava devolve a aba na próxima abertura: o histórico dela precisa continuar lá.
  if (!isReadOnly(stateFile)) forgetScrollbacks(before)
  mobileServer?.publishState()
  return state
}

// Histórico de terminal é um arquivo por aba: sai junto com a aba que acabou de deixar o estado (fechou de
// verdade, projeto removido, celular). Comparar com a pasta inteira apagaria o histórico de aba que um estado
// recuperado não conhece. Roda depois de gravar as abas, nunca antes.
function forgetScrollbacks(before: KoraState['tabs']): void {
  const kept = new Set(state.tabs.map((t) => t.id))
  scrollbacks?.prune(before.filter((t) => !kept.has(t.id)).map((t) => t.id))
}

const sameAgent = (a: AgentSession | null, b: AgentSession | null): boolean =>
  a?.kind === b?.kind && a?.sessionId === b?.sessionId && a?.name === b?.name && a?.derivedName === b?.derivedName

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
// Abas que rodavam quando a atualização fechou o app; o renderer pede uma vez e reabre.
let resumeAfterUpdate: string[] = []
let crashReloads: number[] = []

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

// O mínimo acompanha o zoom da interface e o monitor em que a janela está.
function applyMinimumSize(): void {
  if (!mainWindow) return
  const { workArea } = screen.getDisplayMatching(mainWindow.getBounds())
  const min = minWindowSize(state.settings.zoom, workArea)
  mainWindow.setMinimumSize(min.width, min.height)
}

const memorySoftMB = softLimitMB(totalmem() / 1024 / 1024)

function windowMemoryMB(): number | null {
  const contents = mainWindow?.webContents
  if (!contents || contents.isDestroyed()) return null
  return rendererMemoryMB(app.getAppMetrics(), contents.getOSProcessId())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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

  applyMinimumSize()
  // Levada para um monitor menor, a janela precisa de um mínimo que caiba nele.
  mainWindow.on('moved', applyMinimumSize)
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // O zoom do Chromium é por origem e se perde no reload; reaplica o salvo a cada carregamento.
  mainWindow.webContents.on('did-finish-load', () => mainWindow?.webContents.setZoomFactor(state.settings.zoom))
  // X da janela vai para a bandeja com as abas rodando: quem encerra os processos é o Sair do menu da bandeja.
  // Sem bandeja o X encerra, e aí quem pergunta pelos arquivos não salvos é este handler (o before-quit só vem
  // depois da janela fechar).
  mainWindow.on('close', (event) => {
    detectAgents()
    if (quitting) return
    // O X é o que sobra para quem ficou com a interface sem aceitar clique: a pergunta dos arquivos não salvos
    // precisa voltar a ser clicável, e a janela reaberta pela bandeja também.
    releaseInput()
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
    if (/^(https?:\/\/|mailto:)/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  // Recarregar a interface (queda, ou o reload do desenvolvimento) não encerra os terminais: os ptys vivem no main
  // e a página nova se liga de novo a eles pelo terminal:reattach, que também encerra os que ficaram sem aba.
  // Sem isto a janela fica em branco até alguém fechar o Kora pela bandeja. O que estava só na interface (edição
  // não salva) se perde; a tela dos terminais vem da cópia do main.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (quitting) return
    const decision = decideCrashReload(details.reason, crashReloads, Date.now())
    crashReloads = decision.recent
    if (decision.action === 'ignore' || !mainWindow) return
    recoveryNotice = crashNotice(details.reason)
    unsaved = false
    const running = terminals.pids().size
    // Desistir não encerra os terminais: um agente no meio do trabalho segue até o fim, e o Abrir Kora da bandeja
    // tenta a interface de novo (showWindow). Sair continua encerrando tudo.
    if (decision.action === 'give-up') {
      errorLog.record(
        'processo',
        `interface não recarregada: caiu ${CRASH_RELOADS_PER_WINDOW} vezes em menos de um minuto; ${running} terminal(is) seguem rodando até reabrir pela bandeja`
      )
      return
    }
    errorLog.record('processo', `recarregando a interface (${details.reason}); ${running} terminal(is) seguem rodando para reconectar`)
    mainWindow.webContents.reload()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const vitrine = process.env['KORA_VITRINE'] === '1' ? '#vitrine' : ''
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + vitrine)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Antes de sair, e ao esconder na bandeja, a interface grava o buffer das abas vivas.
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
  // As abas seguem rodando, mas o histórico só existe na interface: a cópia em disco é o que sobra se ela cair
  // ou a energia acabar com o Kora na bandeja.
  requestScrollbackFlush(() => {})
  mainWindow?.hide()
  mainWindow?.webContents.send('app:hidden')
}

function releaseInput(): void {
  const contents = mainWindow?.webContents
  if (!contents || contents.isDestroyed()) return
  releaseStuckDrag(contents).catch((err) => {
    // Janela fechando no meio do comando não é erro: o X sem bandeja e o Sair passam por aqui.
    if (!contents.isDestroyed()) console.error('[kora] destravar a interface', err)
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
    const { dir, ...ref } = tab
    const saved = { ...ref, titleLocked: tab.titleLocked ?? false, agent: null, ...(typeof dir === 'string' && dir ? { dir } : {}) }
    commit({ ...state, tabs: [...state.tabs, saved] })
  }
}

function launchTerminal(tab: TabRef, cols: number, rows: number, launch: Launch): void {
  const root = projectRoot(tab.projectId)
  ensureTab(tab)
  const cwd = terminalCwd(root, state.tabs.find((t) => t.id === tab.id)?.dir)
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
  // A interface pode achar que a aba está adormecida enquanto o pty antigo ainda vive; o pedido novo substitui o
  // antigo em vez de falhar.
  terminals.kill(tab.id)
  terminals.spawn(tab.id, cwd, cols, rows, startup)
}

// Fora de casa: o PC fica no ponto de encontro (relay). KORA_RELAY_URL troca o relay nos testes e no desenvolvimento.
const RELAY_URL = process.env['KORA_RELAY_URL'] ?? 'wss://kora-sync.eduardom.com.br'
let keepAwake: number | null = null

// Sistema e versão para o painel do dono do servidor (X-Kora-Client): "windows/10.0.26100 kora/0.1.34".
const RELAY_CLIENT = `${process.platform === 'win32' ? 'windows' : process.platform}/${release()} kora/${app.getVersion()}`

function setRemoteEnabled(enabled: boolean): MobileStatus {
  const server = mobileServer!
  if (enabled && !server.pairing.remote.email) throw new Error('Entre na sua conta do Kora para ligar o acesso fora de casa.')
  server.pairing.setRemote(enabled)
  if (!enabled) {
    if (keepAwake !== null) powerSaveBlocker.stop(keepAwake)
    keepAwake = null
    return server.stopRemote()
  }
  // Longe de casa por dias: o PC suspenso some do relay até alguém voltar para acordá-lo.
  keepAwake ??= powerSaveBlocker.start('prevent-app-suspension')
  return server.startRemote(RELAY_URL, RELAY_CLIENT)
}

// Verificar o código e redefinir a senha já entram em seguida: quem acabou de digitar a senha não digita de novo.
async function mobileAccount(action: AccountAction): Promise<MobileStatus> {
  const server = mobileServer!
  const client = accountClient(RELAY_URL, () => server.pairing.identity(), hostname(), RELAY_CLIENT)
  await client.send(action)
  if (action.acao === 'cadastro' || action.acao === 'esqueci') return server.status()
  // O código já foi usado: se só o login de depois falhar, a tela precisa saber que a senha valeu (e pedir Entrar).
  if (action.acao !== 'entrar') await client.send({ acao: 'entrar', email: action.email, senha: action.senha }).catch((error: Error) => {
    throw new Error(`Senha gravada. Não deu para entrar agora (${error.message}); use Entrar.`)
  })
  server.pairing.setRemote(true, action.email.trim().toLowerCase())
  return setRemoteEnabled(true)
}

// Abrir com o Windows é escolha de cada um, nas Configurações; a fonte da verdade é o próprio Windows. No
// desenvolvimento quem abriria seria o electron.exe solto, sem o Kora: só o instalado se registra.
function openAtLogin(enabled?: boolean): { available: boolean; enabled: boolean } {
  if (!app.isPackaged) return { available: false, enabled: false }
  if (enabled !== undefined) app.setLoginItemSettings({ openAtLogin: enabled })
  return { available: true, enabled: app.getLoginItemSettings().openAtLogin }
}

async function setMobileEnabled(enabled: boolean): Promise<MobileStatus> {
  const server = mobileServer!
  if (!enabled) return server.stop()
  return server.start()
}

function registerIpc(): void {
  ipcMain.on('runtime:windows-build', (event) => {
    event.returnValue = Number(release().split('.')[2]) || 0
  })
  ipcMain.handle('state:get', () => state)
  ipcMain.handle('state:recovery-notice', () => {
    const notice = recoveryNotice
    recoveryNotice = null
    return notice
  })
  ipcMain.handle('tabs:resume-after-update', () => {
    const ids = resumeAfterUpdate
    resumeAfterUpdate = []
    return ids
  })
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
      applyMinimumSize()
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
    return commit(removeProject(state, id))
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

  ipcMain.handle('fs:list', (_e, id: string, rel: unknown) => {
    const root = projectRoot(id)
    const entries = listDir(root, pathArg(rel))
    watchers.watch(id, root)
    return entries
  })
  ipcMain.handle('fs:list-project', (_e, id: string) => listProjectFiles(projectRoot(id)))
  const projectSearch = latestSearch()
  ipcMain.handle('fs:search', (_e, id: string, query: unknown, opts: unknown) =>
    projectSearch(projectRoot(id), textArg(query, 'o texto da busca'), normalizeSearchOptions(opts))
  )
  ipcMain.handle('fs:read', (_e, id: string, rel: unknown, opts?: { force?: unknown; encoding?: unknown }) =>
    readText(projectRoot(id), pathArg(rel), { force: opts?.force === true, encoding: typeof opts?.encoding === 'string' ? opts.encoding : undefined })
  )
  ipcMain.handle('fs:read-sheet', (_e, id: string, rel: unknown, opts?: { force?: unknown }) =>
    readSheetBytes(projectRoot(id), pathArg(rel), { force: opts?.force === true })
  )
  ipcMain.handle('memory:usage', (): MemoryUsage | null => {
    const usedMB = windowMemoryMB()
    return usedMB === null ? null : { usedMB, softMB: memorySoftMB }
  })
  ipcMain.handle('memory:file-sizes', (_e, id: string, rels: unknown) => fileSizes(projectRoot(id), pathListArg(rels)))
  ipcMain.handle(
    'fs:write',
    (_e, id: string, rel: unknown, content: unknown, expectedMtimeMs: unknown, encodingId?: unknown, opts?: { forceEncoding?: unknown }): SaveResult => {
      try {
        const forceEncoding = opts?.forceEncoding === true
        return {
          ok: true,
          mtimeMs: writeText(projectRoot(id), pathArg(rel), textArg(content, 'o conteúdo'), numberArg(expectedMtimeMs, 'a versão do arquivo'), typeof encodingId === 'string' ? encodingId : undefined, { recreate: true, forceEncoding })
        }
      } catch (err) {
        return { ok: false, conflict: err instanceof ConflictError, message: (err as Error).message }
      }
    }
  )
  ipcMain.handle('fs:open', async (_e, id: string, rel: unknown) => {
    const error = await shell.openPath(resolveInside(projectRoot(id), pathArg(rel)))
    if (error) throw new Error(error)
  })
  ipcMain.handle('fs:info', async (_e, id: string, rel: unknown) => {
    const file = resolveInside(projectRoot(id), pathArg(rel))
    const info = statSync(file)
    return { size: info.size, mtimeMs: info.mtimeMs, app: await defaultAppFor(file) }
  })
  ipcMain.handle('fs:exists', (_e, id: string, rel: unknown) =>
    statSync(resolveInside(projectRoot(id), pathArg(rel)), { throwIfNoEntry: false })?.isFile() ?? false
  )

  ipcMain.handle(
    'fs:create',
    async (_e, id: string, parentRel: unknown, name: unknown, kind: unknown): Promise<CreateResult> => {
      try {
        if (kind !== 'file' && kind !== 'dir') throw new Error('Pedido inválido: o tipo precisa ser arquivo ou pasta.')
        const root = projectRoot(id)
        const { rel, top } = createEntry(root, pathArg(parentRel, 'a pasta'), textArg(name, 'o nome'), kind)
        return { ok: true, rel, top, stamp: await treeStamp(root, top) }
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
  ipcMain.handle('app:open-at-login', (_e, enabled: unknown) => openAtLogin(z.boolean().optional().parse(enabled ?? undefined)))
  ipcMain.handle('terminal:resolve-link', (_e, id: string, text: string, tabId?: unknown) => {
    const dir = typeof tabId === 'string' ? state.tabs.find((t) => t.id === tabId && t.projectId === id)?.dir : undefined
    return resolveTerminalLink(projectRoot(id), String(text), dir)
  })
  ipcMain.on('diag:long-task', (_e, ms: number) => lagLog(`${new Date().toISOString()} interface travada ${Math.round(Number(ms))} ms`))
  ipcMain.on('window:release-stuck-drag', () => {
    lagLog(`${new Date().toISOString()} arrasto preso na interface: cancelado sozinho`)
    releaseInput()
  })
  ipcMain.handle('fs:move', (_e, id: string, fromRel: unknown, toDirRel: unknown) =>
    moveEntry(projectRoot(id), pathArg(fromRel), pathArg(toDirRel, 'a pasta de destino'))
  )
  const withStamps = async (root: string, rels: string[]): Promise<{ rel: string; stamp: string }[]> => {
    const items: { rel: string; stamp: string }[] = []
    for (const rel of rels) items.push({ rel, stamp: await treeStamp(root, rel) })
    return items
  }
  ipcMain.handle('fs:import', async (_e, id: string, sources: unknown, toDirRel: unknown) => {
    const root = projectRoot(id)
    return withStamps(root, await importEntries(root, z.array(z.string().min(1)).parse(sources), pathArg(toDirRel, 'a pasta de destino')))
  })
  ipcMain.handle('fs:copy', async (_e, id: string, rels: unknown, toDirRel: unknown) => {
    const root = projectRoot(id)
    return withStamps(root, await copyEntries(root, z.array(z.string().min(1)).parse(rels), pathArg(toDirRel, 'a pasta de destino')))
  })
  ipcMain.handle('fs:undo', (_e, id: string, step: unknown) =>
    undoTreeStep(projectRoot(id), TreeUndoStepSchema.parse(step), (abs) => shell.trashItem(abs))
  )
  ipcMain.handle('fs:rename', (_e, id: string, rel: unknown, name: unknown) =>
    renameEntry(projectRoot(id), pathArg(rel), textArg(name, 'o nome novo'))
  )
  ipcMain.handle('fs:reveal', async (_e, id: string, relArg: unknown) => {
    const rel = pathArg(relArg)
    const target = resolveInside(projectRoot(id), rel)
    if (!rel || statSync(target).isDirectory()) {
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    } else {
      shell.showItemInFolder(target)
    }
  })
  // Vai para a Lixeira em vez de apagar: um clique errado no explorador tem volta.
  ipcMain.handle('fs:trash', (_e, id: string, relArg: unknown) => trashEntry(projectRoot(id), pathArg(relArg), (abs) => shell.trashItem(abs)))
  ipcMain.handle('fs:open-browser', (_e, id: string, rel: unknown) =>
    openInDefaultBrowser(resolveInside(projectRoot(id), pathArg(rel)))
  )

  ipcMain.handle('project:icon', (_e, id: string) => projectIcons.get(id, projectRoot(id)))
  ipcMain.handle('project:icon-refresh', (_e, id: string) => projectIcons.refresh(id, projectRoot(id)))

  ipcMain.handle('git:status', (_e, id: string) => gitStatus(projectRoot(id)))
  ipcMain.handle('git:branches', (_e, id: string) => gitBranches(projectRoot(id)))
  ipcMain.handle('git:worktrees', (_e, id: string) => gitWorktrees(projectRoot(id)))
  ipcMain.handle('git:init', (_e, id: string) => gitInit(projectRoot(id)))
  ipcMain.handle('git:remote-url', (_e, id: string) => gitRemoteUrl(projectRoot(id)))
  ipcMain.handle('git:set-remote', (_e, id: string, url: unknown) => gitSetRemote(projectRoot(id), textArg(url, 'a URL do remoto')))
  ipcMain.handle('git:create-branch', (_e, id: string, name: unknown, checkout: boolean) =>
    gitCreateBranch(projectRoot(id), textArg(name, 'o nome da branch'), checkout === true)
  )
  ipcMain.handle('git:checkout', (_e, id: string, name: unknown, remote: string | null, mode?: unknown) =>
    gitCheckout(projectRoot(id), nameArg(name, 'o nome da branch'), typeof remote === 'string' ? remote : null, checkoutMode(mode))
  )
  ipcMain.handle('git:ignored', async (_e, id: string, relPaths: unknown) => [...(await gitIgnored(projectRoot(id), pathListArg(relPaths)))])
  const pathList = (paths: unknown): string[] => pathListArg(paths, 'a lista de arquivos')
  const checkoutMode = (mode: unknown): GitCheckoutMode =>
    mode === 'stash' || mode === 'migrate' || mode === 'force' ? mode : 'normal'
  const pullStrategy = (strategy: unknown): GitPullStrategy => (strategy === 'merge' || strategy === 'rebase' ? strategy : 'default')
  const stashRef = (ref: unknown): GitStashRef => {
    const r = typeof ref === 'object' && ref !== null ? (ref as { index?: unknown; oid?: unknown }) : {}
    return { index: Number(r.index), oid: String(r.oid) }
  }
  ipcMain.handle('git:stage', (_e, id: string, paths: unknown) => gitStage(projectRoot(id), pathList(paths)))
  ipcMain.handle('git:unstage', (_e, id: string, paths: unknown) => gitUnstage(projectRoot(id), pathList(paths)))
  // Não rastreado descartado vai para a Lixeira, como o excluir do explorador.
  ipcMain.handle('git:discard', (_e, id: string, paths: unknown) =>
    gitDiscard(projectRoot(id), pathList(paths), (abs) => shell.trashItem(abs))
  )
  ipcMain.handle('git:diff', (_e, id: string, rel: unknown, staged: boolean) => gitDiff(projectRoot(id), pathArg(rel), staged === true))
  ipcMain.handle('git:commit', (_e, id: string, message: unknown, stageAll: boolean) =>
    gitCommit(projectRoot(id), textArg(message, 'a mensagem do commit'), stageAll === true)
  )
  ipcMain.handle('git:push', (_e, id: string, opts?: unknown) => {
    const lease = typeof opts === 'object' && opts !== null ? (opts as { forceWithLease?: unknown }).forceWithLease : undefined
    return gitPush(projectRoot(id), typeof lease === 'string' ? { forceWithLease: lease } : {})
  })
  ipcMain.handle('git:pull', (_e, id: string, strategy?: unknown) => gitPull(projectRoot(id), pullStrategy(strategy)))
  ipcMain.handle('git:fetch', (_e, id: string) => gitFetch(projectRoot(id)))
  ipcMain.handle('git:sync', (_e, id: string, strategy?: unknown) => gitSync(projectRoot(id), pullStrategy(strategy)))
  ipcMain.handle('git:resolve', (_e, id: string, paths: unknown, opts: unknown) => {
    const o = typeof opts === 'object' && opts !== null ? (opts as { force?: unknown; deletion?: unknown }) : {}
    const deletion: GitDeletionChoice | undefined = o.deletion === 'keep' || o.deletion === 'delete' ? o.deletion : undefined
    return gitResolve(projectRoot(id), pathList(paths), { force: o.force === true, deletion })
  })
  ipcMain.handle('git:abort-operation', (_e, id: string) => gitAbortOperation(projectRoot(id)))
  ipcMain.handle('git:continue-operation', (_e, id: string, message: unknown) =>
    gitContinueOperation(projectRoot(id), typeof message === 'string' ? message : '')
  )
  ipcMain.handle('git:stash-list', (_e, id: string) => gitStashList(projectRoot(id)))
  ipcMain.handle('git:stash-push', (_e, id: string, message: unknown, includeUntracked: unknown) =>
    gitStashPush(projectRoot(id), typeof message === 'string' ? message : '', includeUntracked === true)
  )
  ipcMain.handle('git:stash-apply', (_e, id: string, ref: unknown, pop: unknown) => gitStashApply(projectRoot(id), stashRef(ref), pop === true))
  ipcMain.handle('git:stash-drop', (_e, id: string, ref: unknown) => gitStashDrop(projectRoot(id), stashRef(ref)))
  ipcMain.handle('git:stash-files', (_e, id: string, ref: unknown) => gitStashFiles(projectRoot(id), stashRef(ref)))

  const optionalText = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
  ipcMain.handle('git:log', (_e, id: string, opts: unknown) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
    return gitLog(projectRoot(id), {
      skip: typeof o.skip === 'number' ? o.skip : undefined,
      limit: typeof o.limit === 'number' ? o.limit : undefined,
      path: optionalText(o.path)
    })
  })
  ipcMain.handle('git:commit-files', (_e, id: string, hash: unknown) => gitCommitFiles(projectRoot(id), nameArg(hash, 'o commit')))
  ipcMain.handle('git:commit-diff', (_e, id: string, hash: unknown, rel: unknown, origPath: unknown) =>
    gitCommitDiff(projectRoot(id), nameArg(hash, 'o commit'), pathArg(rel), optionalText(origPath))
  )
  ipcMain.handle('git:file-at', (_e, id: string, rev: unknown, rel: unknown) =>
    gitFileAt(projectRoot(id), nameArg(rev, 'o commit'), pathArg(rel))
  )
  ipcMain.handle('git:head-commit', (_e, id: string) => gitHeadCommit(projectRoot(id)))
  ipcMain.handle('git:amend', (_e, id: string, message: unknown) => gitCommitAmend(projectRoot(id), textArg(message, 'a mensagem do commit')))
  ipcMain.handle('git:undo-last-commit', (_e, id: string) => gitUndoLastCommit(projectRoot(id)))
  ipcMain.handle('git:delete-branch', (_e, id: string, name: unknown, force: unknown) =>
    gitDeleteBranch(projectRoot(id), nameArg(name, 'o nome da branch'), force === true)
  )
  ipcMain.handle('git:rename-branch', (_e, id: string, from: unknown, to: unknown) =>
    gitRenameBranch(projectRoot(id), nameArg(from, 'o nome da branch'), textArg(to, 'o nome novo da branch'))
  )
  ipcMain.handle('git:publish-branch', (_e, id: string, name: unknown) => gitPublishBranch(projectRoot(id), nameArg(name, 'o nome da branch')))
  ipcMain.handle('git:add-to-ignore', (_e, id: string, paths: unknown) => gitAddToIgnore(projectRoot(id), pathList(paths)))
  ipcMain.handle('git:hunks', (_e, id: string, rel: unknown, staged: unknown) => gitHunks(projectRoot(id), pathArg(rel), staged === true))
  ipcMain.handle('git:apply-hunk', (_e, id: string, rel: unknown, staged: unknown, hunkId: unknown, action: unknown) => {
    if (action !== 'stage' && action !== 'unstage' && action !== 'discard') throw new Error('Ação de trecho inválida.')
    return gitApplyHunk(projectRoot(id), pathArg(rel), staged === true, nameArg(hunkId, 'o trecho'), action)
  })

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
    try {
      commit(mergeTabs(state, tabs, baseline))
    } catch (err) {
      console.error('[kora] falha ao salvar as abas ao fechar', err)
    } finally {
      // sendSync espera esta resposta: sem ela a janela trava ao fechar.
      event.returnValue = true
    }
  })
  ipcMain.handle('tabs:save', (_e, tabs: TabRef[], baseline?: TabRef[]) => {
    commit(mergeTabs(state, tabs, baseline))
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
  // A interface pede ao carregar: na primeira abertura não há nada vivo; depois de recarregar, os ptys que
  // sobreviveram. Os sem aba são encerrados aqui, porque nenhuma interface vai pedi-los de novo.
  ipcMain.handle('terminal:reattach', () => {
    const plan = reattachPlan(terminals.pids().keys(), state.tabs)
    for (const id of plan.orphans) terminals.kill(id)
    if (plan.orphans.length) errorLog.record('processo', `${plan.orphans.length} terminal(is) sem aba encerrado(s) ao reconectar a interface`)
    return plan.attach.map((id) => ({ id, activity: activities.get(id) ?? null }))
  })
  ipcMain.on('terminal:kill', (_e, id: string) => terminals.kill(id))
  ipcMain.handle('mobile:status', () => mobileServer!.status())
  ipcMain.handle('mobile:enabled', (_e, enabled: unknown) => setMobileEnabled(z.boolean().parse(enabled)))
  ipcMain.handle('mobile:remote', (_e, enabled: unknown) => setRemoteEnabled(z.boolean().parse(enabled)))
  ipcMain.handle('mobile:account', (_e, action: unknown) => mobileAccount(AccountActionSchema.parse(action)))
  ipcMain.handle('mobile:signout', async () => {
    const server = mobileServer!
    await server.signOut(() => accountClient(RELAY_URL, () => server.pairing.identity(), hostname(), RELAY_CLIENT).signOut())
    return setRemoteEnabled(false)
  })
  ipcMain.handle('mobile:admin', (_e, request: unknown) => mobileServer!.adminRequest(AdminRequestSchema.parse(request)))
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

// Na bandeja as abas seguem rodando, e o xterm consome a saída por timers. Janela oculta roda timers poucas vezes
// por segundo no padrão do Chromium: a saída de um agente se acumularia na interface e, acima de 50 MB, o xterm
// descarta. A página continua oculta para o resto (nada é desenhado, o Git não consulta).
app.commandLine.appendSwitch('disable-background-timer-throttling')

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

// Duas instâncias gravariam o mesmo kora-state.json e uma apagaria os projetos da outra. app.quit() não interrompe
// quem chega depois: sem o desvio no whenReady, a segunda ainda abriria o estado e a conexão do celular.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

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
  // A recarga automática desistiu depois de quedas seguidas: abrir pela bandeja é o pedido de tentar de novo.
  if (mainWindow.webContents.isCrashed()) mainWindow.webContents.reload()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  releaseInput()
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
      { label: 'Destravar interface', click: releaseInput },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() }
    ])
  )
  tray.on('click', showWindow)
}

app.on('second-instance', showWindow)
nativeTheme.on('updated', () => mainWindow?.setTitleBarOverlay(titleBarOverlay()))

void app.whenReady().then(() => {
  if (!primaryInstance) return
  stateFile = join(app.getPath('userData'), 'kora-state.json')
  const loaded = loadState(stateFile)
  state = loaded.state
  recoveryNotice = loaded.recovery && recoveryMessage(loaded.recovery)
  // Aba de projeto cuja pasta sumiu fica suspensa, para a tela de localizar a pasta aparecer em vez de um erro.
  resumeAfterUpdate = takeLiveTabs(resumeFile()).filter((id) => {
    const tab = state.tabs.find((t) => t.id === id)
    const project = tab && state.projects.find((p) => p.id === tab.projectId)
    return project !== undefined && existsSync(project.path)
  })
  if (resumeAfterUpdate.length) updaterLog(`reabrindo ${resumeAfterUpdate.length} aba(s) que rodavam antes da atualização`)
  scrollbacks = new Scrollbacks(join(app.getPath('userData'), 'scrollback'))
  scrollbacks.prune([])
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
  // O menu padrão do Electron traz Ctrl+W (fecha a janela) e Ctrl+R (recarrega a interface e perde a edição não
  // salva dos arquivos); os atalhos do Kora ficam todos na interface.
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
    metrics: (agent, path) => sessionMetrics(metricsSources, agent, path),
    dayMetrics: (since) => dayMetrics(metricsSources, since),
    dictation: transcriberInstalled,
    accounts: () => claudeAccounts.list(),
    switchAccount: async (id) => {
      await claudeAccounts.switchTo(id)
      usage.forget('claude')
    },
    trash: (abs) => shell.trashItem(abs),
    removed: (id) => watchers.unwatch(id),
    watch: (id, root) => watchers.watch(id, root),
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
    fileDir: join(app.getPath('temp'), 'kora-anexos'),
    audioDir: join(app.getPath('temp'), 'kora-audio'),
    transcribe: createTranscriber(),
    pdfjsDir: is.dev ? join(app.getAppPath(), 'node_modules', 'pdfjs-dist') : join(app.getAppPath(), 'resources', 'pdfjs'),
    edition: is.dev ? 'dev' : 'prod',
    // Porta própria no Dev: com o Kora instalado aberto, os dois ficam ligados ao celular ao mesmo tempo.
    port: Number(process.env['KORA_MOBILE_PORT']) || (is.dev ? 43128 : 43127),
    runtime: mobileRuntime,
    changed: mobileChanged,
    statusChanged: (status) => mainWindow?.webContents.send('mobile:status', status)
  })
  setInterval(detectAgents, DETECT_FALLBACK_MS)
  agentFolders.start()
  createWindow()
  // Antes de a janela cair por falta de memória: pede para ela descarregar abas inativas e avisar. A recarga
  // automática do render-process-gone continua sendo a rede para quando nem isso basta.
  startMemoryWatch({ usedMB: windowMemoryMB, send: (pressure) => mainWindow?.webContents.send('memory:pressure', pressure) }, memorySoftMB)
  createTray()
  if (mobileServer.pairing.enabled) void setMobileEnabled(true).catch((err) => console.error('[kora] conexão com o celular', err))
  if (mobileServer.pairing.remote.enabled) {
    try { setRemoteEnabled(true) } catch (err) { console.error('[kora] fora de casa', err) }
  }
  // Volta da suspensão: a conexão com o relay morreu enquanto o PC dormia e é refeita na hora.
  powerMonitor.on('resume', () => mobileServer?.reconnectRemote())
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
        const live = [...terminals.pids().keys()]
        try {
          rememberLiveTabs(resumeFile(), live)
          updaterLog(`${live.length} aba(s) rodando, para reabrir depois de instalar`)
        } catch (err) {
          updaterLog(`não deu para guardar as abas rodando: ${errorText(err)}`)
        }
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
