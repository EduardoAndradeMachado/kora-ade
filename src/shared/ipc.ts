import type { KoraState, ProjectGroup, ThemePreference } from './state'
import type { AgentActivity, AgentSession } from './agent'
import type { GitBranch, GitStatus, GitWorktree } from './git-types'
import type { AgentUsage } from './usage-types'
import type { UpdateStatus } from './update'

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
}

export interface TextFile {
  content: string
  mtimeMs: number
}

// O que mudou no disco de um projeto, por quem quer que seja: pastas cuja listagem mudou ('' = raiz),
// status do Git possivelmente diferente, regras de ignorados (.gitignore) alteradas, ou "releia tudo"
// quando não dá para saber (buffer do watcher estourado, watcher perdido).
export interface FilesChange {
  dirs: string[]
  git: boolean
  ignoreRules: boolean
  rescan: boolean
}

export type CreateResult = { ok: true; rel: string } | { ok: false; message: string }

export type SaveResult = { ok: true; mtimeMs: number } | { ok: false; conflict: boolean; message: string }

export type Launch =
  | { type: 'shell' }
  | { type: 'claude' }
  | { type: 'codex' }
  | { type: 'resume'; agent: AgentSession }

export interface SessionSummary {
  kind: AgentSession['kind']
  sessionId: string
  title: string
  updatedAt: number
}

export interface TabRef {
  id: string
  projectId: string
  title: string
  titleLocked?: boolean
}

// Por que o app pediu para a interface resolver os arquivos não salvos: o X esconde na bandeja, o resto encerra.
export type CloseKind = 'hide' | 'quit'

export interface KoraApi {
  windowsBuild: number

  getState(): Promise<KoraState>
  setTheme(theme: ThemePreference): Promise<KoraState>
  setSizes(sizes: { zoom?: number; terminalFontSize?: number; fileFontSize?: number }): Promise<KoraState>
  addProject(): Promise<KoraState>
  addProjectPath(path: string): Promise<KoraState>
  removeProject(id: string): Promise<KoraState>
  // Categorias e posição de cada projeto na lateral; o main confere e devolve o estado salvo.
  saveLayout(layout: {
    groups: ProjectGroup[]
    placements: { id: string; hidden: boolean; groupId: string | null }[]
  }): Promise<KoraState>

  listDir(projectId: string, rel: string): Promise<FileEntry[]>
  onFilesChanged(listener: (projectId: string, change: FilesChange) => void): () => void
  readText(projectId: string, rel: string): Promise<TextFile>
  writeText(projectId: string, rel: string, content: string, expectedMtimeMs: number): Promise<SaveResult>
  openFile(projectId: string, rel: string): Promise<void>
  createEntry(projectId: string, parentRel: string, name: string, kind: 'file' | 'dir'): Promise<CreateResult>
  // Os dois devolvem o caminho relativo novo; nenhum sobrescreve item existente.
  moveEntry(projectId: string, fromRel: string, toDirRel: string): Promise<string>
  renameEntry(projectId: string, rel: string, name: string): Promise<string>
  // Copia para a pasta (relativa ao projeto) o que veio de fora do app; devolve os caminhos relativos novos.
  importEntries(projectId: string, sources: string[], toDirRel: string): Promise<string[]>
  // Caminho impresso no terminal que é um arquivo do projeto; null para qualquer outra coisa.
  resolveTerminalLink(projectId: string, text: string): Promise<{ rel: string; line: number | null } | null>
  // Caminho no disco de um arquivo solto de fora do app (Explorer do Windows); '' se ele não vier do disco.
  pathForFile(file: File): string
  reportLongTask(ms: number): void
  updateStatus(): Promise<UpdateStatus>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  checkUpdate(): Promise<void>
  // Só instala versão já baixada; fecha o app como no "Sair" e reabre atualizado. false se não instalou.
  installUpdate(): Promise<boolean>
  appVersion(): Promise<string>
  // Tema que a interface aplicou: os botões de janela (desenhados pelo Windows) pegam as mesmas cores.
  setWindowDark(dark: boolean): void
  revealInExplorer(projectId: string, rel: string): Promise<void>
  trashEntry(projectId: string, rel: string): Promise<void>
  openInBrowser(projectId: string, rel: string): Promise<void>

  listSessions(projectId: string): Promise<SessionSummary[]>
  // Manda os arquivos da conversa para a Lixeira; recusa se ela estiver ligada a uma aba.
  deleteSession(projectId: string, session: Pick<SessionSummary, 'kind' | 'sessionId'>): Promise<void>
  readUsage(): Promise<AgentUsage[]>
  listOrphans(): Promise<{ key: string; title: string; project: string; agent: AgentSession['kind'] | null; memoryMb: number; processCount: number }[]>
  killOrphan(key: string): Promise<void>
  killAllOrphans(): Promise<void>
  keepOrphans(): Promise<void>

  gitStatus(projectId: string): Promise<GitStatus>
  gitBranches(projectId: string): Promise<GitBranch[]>
  gitWorktrees(projectId: string): Promise<GitWorktree[]>
  gitCreateBranch(projectId: string, name: string, checkout: boolean): Promise<void>
  gitCheckout(projectId: string, name: string, remote: string | null): Promise<void>
  gitIgnored(projectId: string, relPaths: string[]): Promise<string[]>
  gitInit(projectId: string): Promise<void>
  gitRemoteUrl(projectId: string): Promise<string | null>
  // Só aceita URL do GitHub (https ou ssh), sem credenciais; devolve a forma gravada.
  gitSetRemote(projectId: string, url: string): Promise<string>
  projectIcon(projectId: string): Promise<string | null>
  refreshProjectIcon(projectId: string): Promise<string | null>

  saveTabs(tabs: TabRef[]): Promise<void>
  // Síncrono: usado ao descarregar a janela, quando uma chamada assíncrona não chegaria a completar.
  saveTabsNow(tabs: TabRef[]): void
  // O main só segura o fechamento para perguntar quando há arquivo com alteração não salva.
  setUnsaved(unsaved: boolean): void
  onCloseRequested(listener: (kind: CloseKind) => void): () => void
  // A janela foi para a bandeja: as abas de arquivo fecham junto, como fechar o programa.
  onHidden(listener: () => void): () => void
  // Resposta ao pedido: 'proceed' segue com o fechamento (arquivos já salvos ou descartados), 'cancel' mantém aberto.
  answerClose(kind: CloseKind, answer: 'proceed' | 'cancel'): void
  setTabAgent(tab: TabRef, agent: AgentSession | null): Promise<void>
  onTabAgent(listener: (tabId: string, agent: AgentSession | null) => void): () => void
  onTabActivity(listener: (tabId: string, activity: AgentActivity | null) => void): () => void

  spawnTerminal(tab: TabRef, cols: number, rows: number, launch: Launch): Promise<void>
  savePastedImage(bytes: Uint8Array, mime: string): Promise<string>
  writeTerminal(id: string, data: string): void
  resizeTerminal(id: string, cols: number, rows: number): void
  killTerminal(id: string): void
  onTerminalData(listener: (id: string, data: string) => void): () => void
  onTerminalExit(listener: (id: string, exitCode: number) => void): () => void
}
