import { join } from 'node:path'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, shell, Tray } from 'electron'
import { is } from '@electron-toolkit/utils'
import { loadState, saveState } from './store'
import { addProject, applyLayout, mergeTabs, removeProject, setTabAgent } from './projects'
import { Terminals } from './terminals'
import { ConflictError, importEntries, listDir, moveEntry, readText, resolveInside, writeText } from './files'
import { AgentDetector, UNREADABLE } from './agent-detect'
import { createRolloutFinder, FolderWatch } from './agent-watch'
import { listProjectSessions, sessionArtifacts } from './sessions'
import { createEntry, openInDefaultBrowser, renameEntry } from './file-actions'
import { ProjectIcons } from './project-icons'
import { savePastedImage } from './pasted-image'
import { createUsageReader } from './usage'
import { KillOnCloseJob } from './job-object'
import { ProcessRegistry, type Survivor } from './process-registry'
import { ProjectWatchers } from './project-watcher'
import { createLagMonitor } from './lag-monitor'
import { autoUpdater } from 'electron-updater'
import { startUpdates, type Updates } from './updater'
import type { UpdateStatus } from '../shared/update'
import { resolveTerminalLink } from './terminal-links'
import {
  gitBranches,
  gitCheckout,
  gitCreateBranch,
  gitIgnored,
  gitInit,
  gitRemoteUrl,
  gitSetRemote,
  gitStatus,
  gitWorktrees
} from './git'
import { KORA_FILE_PRIVILEGED_SCHEMES, registerKoraFileProtocol } from './file-protocol'
import { fileHolders, listProcesses, withCreationTime } from './processes'
import { FILE_FONT, ProjectGroupSchema, TERMINAL_FONT, ThemePreferenceSchema, ZOOM, type KoraState } from '../shared/state'
import { z } from 'zod'
import { AgentSessionSchema, type AgentActivity, type AgentSession, type Startup } from '../shared/agent'
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
  }
})
let projectIcons: ProjectIcons

let mainWindow: BrowserWindow | null = null
let state: KoraState
let stateFile: string

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

const terminals = new Terminals({
  onData: (id, data) => mainWindow?.webContents.send('terminal:data', id, data),
  onExit: (id, exitCode, pid) => {
    registry?.remove(pid)
    activities.delete(id)
    mainWindow?.webContents.send('terminal:exit', id, exitCode)
  },
  onSpawn: (id, pid) => {
    job?.assign(pid)
    registerLaunch(id, pid)
  }
})

const watchers = new ProjectWatchers((projectId, change) => mainWindow?.webContents.send('fs:changed', projectId, change))

const agentDirs = {
  claudeSessions: join(homedir(), '.claude', 'sessions'),
  codexLocks: join(homedir(), '.codex', 'thread-writer-locks'),
  codexRollouts: join(homedir(), '.codex', 'sessions')
}
const detector = new AgentDetector({
  claudeSessionsDir: agentDirs.claudeSessions,
  codexLocksDir: agentDirs.codexLocks,
  listProcesses,
  creationTime: (p) => withCreationTime(p).createdMs,
  lockHolders: fileHolders,
  codexRollout: createRolloutFinder(agentDirs.codexRollouts)
})
const agentFolders = new FolderWatch(
  [
    { dir: agentDirs.claudeSessions, recursive: false },
    { dir: agentDirs.codexLocks, recursive: false },
    { dir: agentDirs.codexRollouts, recursive: true }
  ],
  () => scheduleDetect()
)

function commit(next: KoraState): KoraState {
  saveState(stateFile, next)
  state = next
  return state
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
}

function detectAgents(): void {
  lag?.note('detectar-sessoes')
  const pids = terminals.pids()
  if (pids.size === 0) return
  try {
    const found = detector.detect(pids)
    for (const [tabId, detected] of found) if (detected !== UNREADABLE) bindAgent(tabId, detected.agent)
    for (const tabId of pids.keys()) {
      const detected = found.get(tabId)
      if (detected !== UNREADABLE) setActivity(tabId, detected?.activity ?? null)
    }
  } catch (err) {
    console.error('[kora] falha ao detectar sessões', err)
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
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = rendererDark ?? nativeTheme.shouldUseDarkColors
  return {
    color: dark ? '#16171b' : '#f6f7f9',
    symbolColor: dark ? '#eceef2' : '#15171b',
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
  mainWindow.webContents.on('did-start-loading', () => {
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

function hideToTray(): void {
  terminals.killAll()
  mainWindow?.hide()
  mainWindow?.webContents.send('app:hidden')
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

function projectRoot(id: string): string {
  const project = state.projects.find((p) => p.id === id)
  if (!project) throw new Error(`Projeto desconhecido: ${id}`)
  return project.path
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
    return commit(removeProject(state, id))
  })

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

  ipcMain.handle('usage:read', () => usage.read())

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

  ipcMain.handle('sessions:list', (_e, projectId: string) =>
    listProjectSessions(join(homedir(), '.claude'), join(homedir(), '.codex'), projectRoot(projectId))
  )

  // Conversa ligada a uma aba (rodando ou adormecida) não é apagada: o "Continuar" dela passaria a falhar.
  ipcMain.handle('sessions:delete', async (_e, projectId: string, session: unknown) => {
    const { kind, sessionId } = AgentSessionSchema.pick({ kind: true, sessionId: true }).parse(session)
    const bound = state.tabs.find((t) => t.agent?.sessionId === sessionId)
    if (bound) throw new Error(`Essa conversa está na aba "${bound.title}". Feche a aba antes de apagar.`)
    const files = await sessionArtifacts(kind, sessionId, projectRoot(projectId), {
      claudeRoot: join(homedir(), '.claude'),
      codexRoot: join(homedir(), '.codex')
    })
    if (files.length === 0) throw new Error('Conversa não encontrada no disco.')
    for (const file of files) await shell.trashItem(file)
  })

  ipcMain.on('app:unsaved', (_e, value: unknown) => {
    unsaved = value === true
  })
  ipcMain.on('app:close-ack', () => clearTimeout(closeAckTimer))
  ipcMain.on('app:close-answer', (_e, kind: unknown, answer: unknown) => {
    if ((kind === 'hide' || kind === 'quit') && answer === 'proceed') proceedClose(kind)
  })

  ipcMain.on('tabs:save-sync', (event, tabs: TabRef[]) => {
    commit(mergeTabs(state, tabs))
    event.returnValue = true
  })
  ipcMain.handle('tabs:save', (_e, tabs: TabRef[]) => {
    commit(mergeTabs(state, tabs))
  })
  // O vínculo manual pode chegar antes do save debounced do renderer; a aba entra no estado aqui.
  const ensureTab = (tab: TabRef): void => {
    projectRoot(tab.projectId)
    if (!state.tabs.some((t) => t.id === tab.id)) {
      commit({ ...state, tabs: [...state.tabs, { ...tab, titleLocked: tab.titleLocked ?? false, agent: null }] })
    }
  }

  ipcMain.handle('tab:set-agent', (_e, tab: TabRef, agent: unknown) => {
    ensureTab(tab)
    bindAgent(tab.id, agent === null ? null : AgentSessionSchema.parse(agent))
  })

  ipcMain.handle('terminal:spawn', (_e, tab: TabRef, cols: number, rows: number, launch: Launch) => {
      const cwd = projectRoot(tab.projectId)
      ensureTab(tab)
      let startup: Startup | undefined
      if (launch.type === 'claude') {
        const sessionId = randomUUID()
        startup = { kind: 'claude', mode: 'new', sessionId }
        bindAgent(tab.id, { kind: 'claude', sessionId })
      } else if (launch.type === 'codex') {
        startup = { kind: 'codex', mode: 'new' }
      } else if (launch.type === 'resume') {
        const agent = AgentSessionSchema.parse(launch.agent)
        startup = { kind: agent.kind, mode: 'resume', sessionId: agent.sessionId }
      }
      // A interface pode achar que a aba está adormecida enquanto o pty antigo ainda vive
      // (ex.: renderer recarregado); o pedido novo substitui o antigo em vez de falhar.
      terminals.kill(tab.id)
      terminals.spawn(tab.id, cwd, cols, rows, startup)
  })
  ipcMain.handle('clipboard:save-image', (_e, bytes: Uint8Array, mime: string) =>
    savePastedImage(join(app.getPath('temp'), 'kora-paste'), bytes, mime)
  )
  ipcMain.on('terminal:write', (_e, id: string, data: string) => terminals.write(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows)
  )
  ipcMain.on('terminal:kill', (_e, id: string) => terminals.kill(id))
}

protocol.registerSchemesAsPrivileged(KORA_FILE_PRIVILEGED_SCHEMES)

// Testes de ponta a ponta sobem uma instância isolada: estado, ícones e trava de instância única
// ficam na pasta indicada, sem encostar no Kora que o usuário está usando.
// A instância de desenvolvimento tem dados próprios: assim roda ao lado da instalada sem disputar o estado nem a trava de instância única.
if (process.env['KORA_USER_DATA']) app.setPath('userData', process.env['KORA_USER_DATA'])
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Kora ADE Dev'))

// Duas instâncias gravariam o mesmo kora-state.json e uma apagaria os projetos da outra.
if (!app.requestSingleInstanceLock()) app.quit()

let quitting = false
let tray: Tray | null = null
app.on('before-quit', (event) => {
  if (unsaved && !quitConfirmed && mainWindow) {
    event.preventDefault()
    askRenderer('quit')
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
  job = new KillOnCloseJob()
  registry = new ProcessRegistry(join(app.getPath('userData'), 'processes.json'))
  survivors = new Map(registry.findSurvivors().map((s) => [s.key, s]))
  nativeTheme.themeSource = state.settings.theme
  registerKoraFileProtocol(projectRoot)
  projectIcons = new ProjectIcons(join(app.getPath('userData'), 'icons'))
  // O menu padrão do Electron traz Ctrl+W (fecha a janela) e Ctrl+R (recarrega a interface e derruba os
  // terminais); os atalhos do Kora ficam todos na interface.
  Menu.setApplicationMenu(null)
  lag = createLagMonitor({ intervalMs: 100, thresholdMs: 300, write: lagLog })
  traceIpc()
  registerIpc()
  setInterval(detectAgents, DETECT_FALLBACK_MS)
  agentFolders.start()
  createWindow()
  createTray()
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
