import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { FilesChange, KoraApi } from '../shared/ipc'
import type { AgentSession } from '../shared/agent'

function subscribe<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => listener(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: KoraApi = {
  windowsBuild: ipcRenderer.sendSync('runtime:windows-build') as number,

  getState: () => ipcRenderer.invoke('state:get'),
  setTheme: (theme) => ipcRenderer.invoke('settings:theme', theme),
  setSizes: (sizes) => ipcRenderer.invoke('settings:sizes', sizes),
  addProject: () => ipcRenderer.invoke('project:add'),
  addProjectPath: (path) => ipcRenderer.invoke('project:add-path', path),
  removeProject: (id) => ipcRenderer.invoke('project:remove', id),
  saveLayout: (layout) => ipcRenderer.invoke('project:layout', layout),

  listDir: (projectId, rel) => ipcRenderer.invoke('fs:list', projectId, rel),
  onFilesChanged: (listener) => subscribe<[string, FilesChange]>('fs:changed', listener),
  readText: (projectId, rel) => ipcRenderer.invoke('fs:read', projectId, rel),
  writeText: (projectId, rel, content, mtime) => ipcRenderer.invoke('fs:write', projectId, rel, content, mtime),
  openFile: (projectId, rel) => ipcRenderer.invoke('fs:open', projectId, rel),
  createEntry: (projectId, parentRel, name, kind) => ipcRenderer.invoke('fs:create', projectId, parentRel, name, kind),
  revealInExplorer: (projectId, rel) => ipcRenderer.invoke('fs:reveal', projectId, rel),
  trashEntry: (projectId, rel) => ipcRenderer.invoke('fs:trash', projectId, rel),
  moveEntry: (projectId, fromRel, toDirRel) => ipcRenderer.invoke('fs:move', projectId, fromRel, toDirRel),
  resolveTerminalLink: (projectId, text) => ipcRenderer.invoke('terminal:resolve-link', projectId, text),
  pathForFile: (file) => webUtils.getPathForFile(file),
  reportLongTask: (ms) => ipcRenderer.send('diag:long-task', ms),
  pendingUpdate: () => ipcRenderer.invoke('update:pending'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  setWindowDark: (dark) => ipcRenderer.send('window:dark', dark),
  onUpdateReady: (listener) => subscribe<[string]>('update:ready', listener),
  renameEntry: (projectId, rel, name) => ipcRenderer.invoke('fs:rename', projectId, rel, name),
  openInBrowser: (projectId, rel) => ipcRenderer.invoke('fs:open-browser', projectId, rel),

  listSessions: (projectId) => ipcRenderer.invoke('sessions:list', projectId),
  deleteSession: (projectId, session) => ipcRenderer.invoke('sessions:delete', projectId, { kind: session.kind, sessionId: session.sessionId }),
  readUsage: () => ipcRenderer.invoke('usage:read'),
  listOrphans: () => ipcRenderer.invoke('orphans:list'),
  killOrphan: (key) => ipcRenderer.invoke('orphans:kill', key),
  killAllOrphans: () => ipcRenderer.invoke('orphans:kill-all'),
  keepOrphans: () => ipcRenderer.invoke('orphans:keep'),

  gitStatus: (id) => ipcRenderer.invoke('git:status', id),
  gitBranches: (id) => ipcRenderer.invoke('git:branches', id),
  gitWorktrees: (id) => ipcRenderer.invoke('git:worktrees', id),
  gitCreateBranch: (id, name, checkout) => ipcRenderer.invoke('git:create-branch', id, name, checkout),
  gitCheckout: (id, name, remote) => ipcRenderer.invoke('git:checkout', id, name, remote),
  gitIgnored: (id, relPaths) => ipcRenderer.invoke('git:ignored', id, relPaths),
  gitInit: (id) => ipcRenderer.invoke('git:init', id),
  gitRemoteUrl: (id) => ipcRenderer.invoke('git:remote-url', id),
  gitSetRemote: (id, url) => ipcRenderer.invoke('git:set-remote', id, url),
  projectIcon: (projectId) => ipcRenderer.invoke('project:icon', projectId),
  refreshProjectIcon: (projectId) => ipcRenderer.invoke('project:icon-refresh', projectId),

  saveTabs: (tabs) => ipcRenderer.invoke('tabs:save', tabs),
  saveTabsNow: (tabs) => {
    ipcRenderer.sendSync('tabs:save-sync', tabs)
  },
  setTabAgent: (tab, agent) => ipcRenderer.invoke('tab:set-agent', tab, agent),
  onTabAgent: (listener) => subscribe<[string, AgentSession | null]>('tab:agent', listener),

  spawnTerminal: (tab, cols, rows, launch) => ipcRenderer.invoke('terminal:spawn', tab, cols, rows, launch),
  savePastedImage: (bytes, mime) => ipcRenderer.invoke('clipboard:save-image', bytes, mime),
  writeTerminal: (id, data) => ipcRenderer.send('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  killTerminal: (id) => ipcRenderer.send('terminal:kill', id),
  onTerminalData: (listener) => subscribe<[string, string]>('terminal:data', listener),
  onTerminalExit: (listener) => subscribe<[string, number]>('terminal:exit', listener)
}

contextBridge.exposeInMainWorld('kora', api)
