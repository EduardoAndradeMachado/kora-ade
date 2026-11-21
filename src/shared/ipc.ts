import type { Alerts, KoraState, ProjectGroup, ThemePreference } from './state'
import type { AgentActivity, AgentSession } from './agent'
import type { MemoryPressure, MemoryUsage } from './open-limits'
import type { GitBranch, GitCommitResult, GitDiff, GitStatus, GitWorktree } from './git-types'
import type { GitBranchDeleteResult, GitCommitFile, GitHeadCommit, GitHunk, GitHunkAction, GitLogPage } from './git-types'
import type {
  GitCheckoutMode,
  GitCheckoutResult,
  GitContinueResult,
  GitDeletionChoice,
  GitPullResult,
  GitPullStrategy,
  GitPushResult,
  GitPushRewritten,
  GitResolveResult,
  GitStash,
  GitStashFile,
  GitStashRef
} from './git-types'
import type { AgentUsage } from './usage-types'
import type { ClaudeAccountsView } from './claude-accounts'
import type { AntigravityAccountsView } from './antigravity-accounts'
import type { DayPoint, SessionMetrics } from './metrics'
import type { UpdateStatus } from './update'
import type { AccountAction, AdminRequest, DesktopSessionState, MobilePairing, MobileStatus, TerminalSizeEvent, TerminalSnapshot } from './mobile'

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
}

export interface TextFile {
  content: string
  mtimeMs: number
  encoding?: string
  // Identificador para devolver no writeText: arquivo Windows-1252 salvo só com ASCII não teria como ser reconhecido.
  encodingId?: string
  eol?: 'LF' | 'CRLF'
}

export interface ProjectSearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  // "Arquivos a incluir" do VS Code: itens separados por vírgula; ".\pasta" ancora na raiz, "pasta" e glob
  // ("*.ts", "src/**/*.tsx") valem em qualquer nível. Vazio ou ausente: o projeto todo.
  include?: string
  // "Arquivos a excluir", com a mesma sintaxe; vale junto com o incluir.
  exclude?: string
}

// line e column começam em 1; column e length contam em unidades UTF-16, como o Monaco. start/end marcam a
// ocorrência em preview, que pode cortá-la.
export interface ProjectSearchMatch {
  line: number
  column: number
  length: number
  preview: string
  start: number
  end: number
}

export interface ProjectSearchFile {
  path: string
  matches: ProjectSearchMatch[]
}

export interface ProjectSearchResult {
  files: ProjectSearchFile[]
  total: number
  truncated: boolean
  // A lista do projeto passou do teto e só os primeiros arquivos foram lidos.
  capped: boolean
}

// O que mudou no disco de um projeto, por quem quer que seja: pastas cuja listagem mudou ('' = raiz),
// arquivos que podem ter mudado de conteúdo (allFiles quando a lista não cabe ou não dá para saber),
// status do Git possivelmente diferente, regras de ignorados (.gitignore) alteradas, ou "releia tudo"
// quando não dá para saber (buffer do watcher estourado, watcher perdido).
export interface FilesChange {
  dirs: string[]
  files: string[]
  allFiles: boolean
  git: boolean
  ignoreRules: boolean
  rescan: boolean
}

// `top`: primeira pasta (ou o próprio item) que não existia; `stamp` é o retrato dela para o desfazer.
export type CreateResult = { ok: true; rel: string; top: string; stamp: string } | { ok: false; message: string }

export interface CopiedEntry {
  rel: string
  stamp: string
}

// Desfazer da árvore: `remove` manda para a Lixeira o que ela criou (só se continua igual ao retrato), `move` leva
// de volta de `to` para `from`, `restore` tira da Lixeira do Windows o que foi excluído a partir de `since` (ms).
export type TreeUndoStep =
  | { kind: 'remove'; items: CopiedEntry[] }
  | { kind: 'move'; moves: { from: string; to: string }[] }
  | { kind: 'restore'; items: { rel: string; since: number }[] }

// `moved` são os caminhos que mudaram (para as abas acompanharem); `message` diz por que não fez, ou o que faltou.
// `remaining`: com `message`, o passo só com os itens que não foram desfeitos (o passo inteiro se nada mudou).
export interface TreeUndoResult {
  moved: { from: string; to: string }[]
  message: string | null
  remaining: TreeUndoStep | null
}

export type SaveResult = { ok: true; mtimeMs: number } | { ok: false; conflict: boolean; message: string }

export type Launch =
  | { type: 'shell' }
  | { type: 'claude' }
  | { type: 'codex' }
  | { type: 'opencode' }
  | { type: 'antigravity' }
  | { type: 'resume'; agent: AgentSession }

export interface SessionSummary {
  kind: AgentSession['kind']
  sessionId: string
  title: string
  updatedAt: number
  // O título é o nome que o usuário deu à aba dessa conversa; agentTitle guarda o do Claude/Codex.
  named?: boolean
  agentTitle?: string
}

export interface TabRef {
  id: string
  projectId: string
  title: string
  titleLocked?: boolean
  // Pasta inicial do terminal, relativa ao projeto ("Abrir no terminal integrado"); sem ela, a raiz.
  dir?: string
}

// Por que o app pediu para a interface resolver os arquivos não salvos: o X esconde na bandeja, o resto encerra.
export type CloseKind = 'hide' | 'quit'

export interface ErrorSummary {
  count: number
  lastAt: string | null
}

export interface KoraApi {
  windowsBuild: number

  getState(): Promise<KoraState>
  takeRecoveryNotice(): Promise<string | null>
  // Abas que rodavam quando a atualização fechou o app; só a primeira chamada recebe a lista.
  takeResumeAfterUpdate(): Promise<string[]>
  setTheme(theme: ThemePreference): Promise<KoraState>
  setSizes(sizes: { zoom?: number; terminalFontSize?: number; fileFontSize?: number }): Promise<KoraState>
  setAlerts(alerts: Alerts): Promise<KoraState>
  // Abrir o Kora com o Windows; sem argumento só consulta. available: false fora do app instalado.
  openAtLogin(enabled?: boolean): Promise<{ available: boolean; enabled: boolean }>
  setFileWordWrap(on: boolean): Promise<KoraState>
  // Traz a janela para a frente (clique na notificação do Windows).
  focusWindow(): void

  // Log de erros local para suporte: nada sai do computador sem o usuário copiar ou salvar.
  reportError(text: string): void
  errorSummary(): Promise<ErrorSummary>
  // Apaga o log de erros e devolve o resumo depois de limpar.
  clearErrors(): Promise<ErrorSummary>
  recentErrors(): Promise<string>
  // Caminho do arquivo salvo, ou null se o usuário cancelou.
  saveDiagnostic(): Promise<string | null>
  openLogsFolder(): Promise<void>
  onAppError(listener: () => void): () => void
  addProject(): Promise<KoraState>
  addProjectPath(path: string): Promise<KoraState>
  removeProject(id: string): Promise<KoraState>
  // Projetos cuja pasta não existe mais (apagada, movida ou renomeada fora do Kora).
  missingProjects(): Promise<string[]>
  // Abre o seletor de pasta e aponta o projeto para ela; cancelar devolve o estado sem mudança.
  relocateProject(id: string): Promise<KoraState>
  // Nome mostrado no Kora; vazio volta ao nome da pasta, que nunca é renomeada.
  renameProject(id: string, name: string): Promise<KoraState>
  // Pasta recolhida ou expandida na lateral, lembrada entre aberturas do app.
  setProjectCollapsed(id: string, collapsed: boolean): Promise<KoraState>
  // Categorias e posição de cada projeto na lateral; o main confere e devolve o estado salvo.
  saveLayout(layout: {
    groups: ProjectGroup[]
    placements: { id: string; hidden: boolean; groupId: string | null }[]
  }): Promise<KoraState>

  listDir(projectId: string, rel: string): Promise<FileEntry[]>
  // Arquivos do projeto todo: no git, rastreados e não rastreados sem os ignorados; fora dele, tudo menos .git e node_modules.
  listProjectFiles(projectId: string): Promise<string[]>
  // Uma busca nova cancela a anterior, que resolve com null; texto vazio só cancela.
  searchProject(projectId: string, query: string, opts: ProjectSearchOptions): Promise<ProjectSearchResult | null>
  onFilesChanged(listener: (projectId: string, change: FilesChange) => void): () => void
  // force: abre acima do limite normal, até o teto do editor (o usuário pediu "Abrir mesmo assim").
  // encoding: decodifica nessa codificação em vez de detectar ("Reabrir com codificação").
  readText(projectId: string, rel: string, opts?: { force?: boolean; encoding?: string }): Promise<TextFile>
  // Os bytes de um .xlsx para a planilha, com os mesmos limites e mensagens do readText (force = "Abrir mesmo assim").
  readSheetBytes(projectId: string, rel: string, opts?: { force?: boolean }): Promise<Uint8Array>
  // Memória privada do processo da janela e o limite do vigia (null sem medida).
  memoryUsage(): Promise<MemoryUsage | null>
  // Tamanho no disco de cada caminho (0 se sumiu), para estimar quanto cada aba ocupa.
  memoryFileSizes(projectId: string, rels: string[]): Promise<number[]>
  // O vigia do main: a janela passou do limite, libere o que der.
  onMemoryPressure(listener: (pressure: MemoryPressure) => void): () => void
  // forceEncoding: grava em encodingId mesmo que o disco mostre outra ("Salvar com codificação").
  writeText(
    projectId: string,
    rel: string,
    content: string,
    expectedMtimeMs: number,
    encodingId?: string,
    opts?: { forceEncoding?: boolean }
  ): Promise<SaveResult>
  openFile(projectId: string, rel: string): Promise<void>
  // app: nome do programa que o Windows usa para a extensão; null se o Windows for perguntar qual usar.
  fileInfo(projectId: string, rel: string): Promise<{ size: number; mtimeMs: number; app: string | null }>
  // Só arquivo conta: pasta no lugar do arquivo é tão "apagado" quanto nada no lugar.
  fileExists(projectId: string, rel: string): Promise<boolean>
  createEntry(projectId: string, parentRel: string, name: string, kind: 'file' | 'dir'): Promise<CreateResult>
  // Os dois devolvem o caminho relativo novo; nenhum sobrescreve item existente.
  moveEntry(projectId: string, fromRel: string, toDirRel: string): Promise<string>
  renameEntry(projectId: string, rel: string, name: string): Promise<string>
  // Copia para a pasta (relativa ao projeto) o que veio de fora do app; devolve os caminhos relativos novos.
  importEntries(projectId: string, sources: string[], toDirRel: string): Promise<CopiedEntry[]>
  // Colar/duplicar dentro do projeto: cópia com nome livre ("nome (2).ext") quando já existe um igual.
  copyEntries(projectId: string, rels: string[], toDirRel: string): Promise<CopiedEntry[]>
  undoTreeStep(projectId: string, step: TreeUndoStep): Promise<TreeUndoResult>
  // Caminho impresso no terminal que é um arquivo do projeto; null para qualquer outra coisa. Com a aba do terminal,
  // o relativo vale primeiro a partir da pasta em que ela abriu.
  resolveTerminalLink(projectId: string, text: string, terminalTabId?: string): Promise<{ rel: string; line: number | null } | null>
  // Caminho no disco de um arquivo solto de fora do app (Explorer do Windows); '' se ele não vier do disco.
  pathForFile(file: File): string
  reportLongTask(ms: number): void
  // A interface parou de aceitar clique por um arrasto que não terminou: o main cancela o arrasto nela.
  releaseStuckDrag(): void
  updateStatus(): Promise<UpdateStatus>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  checkUpdate(): Promise<void>
  // Só instala versão já baixada; fecha o app como no "Sair" e reabre atualizado. false se não instalou.
  installUpdate(): Promise<boolean>
  appVersion(): Promise<string>
  // Tema que a interface aplicou: os botões de janela (desenhados pelo Windows) pegam as mesmas cores.
  setWindowDark(dark: boolean): void
  // Diálogo com véu aberto: os botões de janela (do Windows, fora da página) escurecem junto.
  setWindowDimmed(dimmed: boolean): void
  revealInExplorer(projectId: string, rel: string): Promise<void>
  trashEntry(projectId: string, rel: string): Promise<void>
  openInBrowser(projectId: string, rel: string): Promise<void>

  listSessions(projectId: string): Promise<SessionSummary[]>
  // Manda os arquivos da conversa para a Lixeira; recusa se ela estiver ligada a uma aba.
  deleteSession(projectId: string, session: Pick<SessionSummary, 'kind' | 'sessionId'>): Promise<void>
  readUsage(): Promise<AgentUsage[]>
  sessionMetrics(projectId: string, agent: Pick<AgentSession, 'kind' | 'sessionId'>): Promise<SessionMetrics>
  // Respostas de todos os agentes desde `since` (ms), para a linha de TPS do dia.
  dayMetrics(since: number): Promise<DayPoint[]>
  // Contas do Claude guardadas no Kora; trocar muda o login do Claude Code no computador todo.
  claudeAccounts(): Promise<ClaudeAccountsView>
  switchClaudeAccount(id: string): Promise<ClaudeAccountsView>
  removeClaudeAccount(id: string): Promise<ClaudeAccountsView>
  // Abre o navegador para entrar numa conta; o login atual não muda. O fim chega por onClaudeAccountsChanged.
  startClaudeLogin(email?: string): Promise<void>
  sendClaudeLoginCode(code: string): void
  cancelClaudeLogin(): void
  dismissClaudeLogin(): void
  onClaudeAccountsChanged(listener: () => void): () => void
  // Contas do agy guardadas no Kora; trocar muda o login do agy no computador todo e exige o agy fechado.
  antigravityAccounts(): Promise<AntigravityAccountsView>
  switchAntigravityAccount(id: string): Promise<AntigravityAccountsView>
  removeAntigravityAccount(id: string): Promise<AntigravityAccountsView>
  // Guarda a conta atual e tira o login do agy; a conta nova entra pelo próprio agy e chega por onAntigravityAccountsChanged.
  addAntigravityAccount(): Promise<AntigravityAccountsView>
  cancelAddAntigravityAccount(): Promise<AntigravityAccountsView>
  onAntigravityAccountsChanged(listener: () => void): () => void
  listOrphans(): Promise<{ key: string; title: string; project: string; agent: AgentSession['kind'] | null; memoryMb: number; processCount: number }[]>
  killOrphan(key: string): Promise<void>
  killAllOrphans(): Promise<void>
  keepOrphans(): Promise<void>

  gitStatus(projectId: string): Promise<GitStatus>
  gitBranches(projectId: string): Promise<GitBranch[]>
  gitWorktrees(projectId: string): Promise<GitWorktree[]>
  gitCreateBranch(projectId: string, name: string, checkout: boolean): Promise<void>
  // Sem `mode`, alteração local que barra a troca volta como 'local-changes' para a interface perguntar.
  gitCheckout(projectId: string, name: string, remote: string | null, mode?: GitCheckoutMode): Promise<GitCheckoutResult>
  gitIgnored(projectId: string, relPaths: string[]): Promise<string[]>
  gitInit(projectId: string): Promise<void>
  gitRemoteUrl(projectId: string): Promise<string | null>
  // Só aceita URL do GitHub (https ou ssh), sem credenciais; devolve a forma gravada.
  gitSetRemote(projectId: string, url: string): Promise<string>
  // Caminhos relativos ao projeto; renomeado staged precisa dos dois (novo e origPath) para sair da fila inteiro.
  gitStage(projectId: string, paths: string[]): Promise<void>
  gitUnstage(projectId: string, paths: string[]): Promise<void>
  // Só o que não está na fila: rastreado volta à versão do index, não rastreado vai para a Lixeira.
  gitDiscard(projectId: string, paths: string[]): Promise<void>
  gitDiff(projectId: string, path: string, staged: boolean): Promise<GitDiff>
  // Fila vazia devolve 'nothing-staged' sem commitar; stageAll coloca todas as alterações do projeto antes.
  gitCommit(projectId: string, message: string, stageAll: boolean): Promise<GitCommitResult>
  // Branch sem upstream é publicada (push -u) no origin.
  // Histórico local reescrito (commit enviado foi corrigido/desfeito) volta como 'rewritten', sem enviar; com
  // `forceWithLease` (o remoteOid devolvido) envia com --force-with-lease.
  gitPush(projectId: string, opts?: { forceWithLease?: string }): Promise<GitPushResult>
  gitPull(projectId: string, strategy?: GitPullStrategy): Promise<GitPullResult>
  gitFetch(projectId: string): Promise<void>
  // Pull e depois Push.
  gitSync(projectId: string, strategy?: GitPullStrategy): Promise<GitPullResult | GitPushRewritten>
  // Marca arquivos em conflito como resolvidos; recusa com marcadores (sem `force`) e conflito de exclusão sem `deletion`.
  gitResolve(projectId: string, paths: string[], opts?: { force?: boolean; deletion?: GitDeletionChoice }): Promise<GitResolveResult>
  gitAbortOperation(projectId: string): Promise<void>
  // Merge: commit com `message`. Rebase, cherry-pick e revert: --continue.
  gitContinueOperation(projectId: string, message: string): Promise<GitContinueResult>
  gitStashList(projectId: string): Promise<GitStash[]>
  gitStashPush(projectId: string, message: string, includeUntracked: boolean): Promise<void>
  gitStashApply(projectId: string, ref: GitStashRef, pop: boolean): Promise<'ok' | 'conflicts'>
  gitStashDrop(projectId: string, ref: GitStashRef): Promise<void>
  gitStashFiles(projectId: string, ref: GitStashRef): Promise<GitStashFile[]>
  // Histórico: do repositório, ou de um arquivo seguindo renomeações (`path`). Paginado por skip/limit.
  gitLog(projectId: string, opts: { skip?: number; limit?: number; path?: string }): Promise<GitLogPage>
  gitCommitFiles(projectId: string, hash: string): Promise<GitCommitFile[]>
  // Diff de um arquivo num commit: primeiro pai ↔ commit (`origPath`: caminho antes do rename).
  gitCommitDiff(projectId: string, hash: string, path: string, origPath?: string): Promise<GitDiff>
  // Conteúdo do arquivo num commit ("HEAD" ou hash); `exists` false se ele não existia ali.
  gitFileAt(projectId: string, rev: string, path: string): Promise<{ text: string; binary: boolean; exists: boolean }>
  gitHeadCommit(projectId: string): Promise<GitHeadCommit | null>
  gitAmend(projectId: string, message: string): Promise<void>
  // reset --soft HEAD~1: as alterações do commit voltam para a fila; devolve a mensagem dele.
  gitUndoLastCommit(projectId: string): Promise<{ message: string }>
  // Sem `force`, branch não mesclada volta 'not-merged' sem apagar.
  gitDeleteBranch(projectId: string, name: string, force: boolean): Promise<GitBranchDeleteResult>
  gitRenameBranch(projectId: string, from: string, to: string): Promise<void>
  gitPublishBranch(projectId: string, name: string): Promise<void>
  // Grava no .gitignore da pasta do projeto; devolve as linhas que entraram (as que já existiam ficam de fora).
  gitAddToIgnore(projectId: string, paths: string[]): Promise<string[]>
  gitHunks(projectId: string, path: string, staged: boolean): Promise<GitHunk[]>
  gitApplyHunk(projectId: string, path: string, staged: boolean, hunkId: string, action: GitHunkAction): Promise<void>
  projectIcon(projectId: string): Promise<string | null>
  refreshProjectIcon(projectId: string): Promise<string | null>

  // baseline: a lista que a interface conhecia; o main preserva o que o celular mudou depois dela.
  saveTabs(tabs: TabRef[], baseline?: TabRef[]): Promise<void>
  // Síncrono: usado ao descarregar a janela, quando uma chamada assíncrona não chegaria a completar.
  saveTabsNow(tabs: TabRef[], baseline?: TabRef[]): void
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
  // Histórico do terminal: um arquivo por aba, apagado quando a aba fecha de verdade.
  saveScrollback(id: string, text: string): Promise<void>
  loadScrollback(id: string): Promise<string | null>
  // O main pede antes de encerrar os processos (esconder, sair, instalar); a resposta sai depois de gravar.
  onFlushScrollback(listener: () => void | Promise<void>): () => void
  onTerminalData(listener: (id: string, data: string, sequence: number) => void): () => void
  onTerminalExit(listener: (id: string, exitCode: number) => void): () => void
  // Tela atual de um terminal já rodando (aberto pelo celular) e o tamanho que ele usa agora.
  terminalSnapshot(id: string): Promise<{ snapshot: TerminalSnapshot | null; size: TerminalSizeEvent | null }>
  // Terminais que continuaram rodando enquanto a interface recarregava (queda); vazio na abertura do app.
  reattachTerminals(): Promise<{ id: string; activity: AgentActivity | null }[]>
  // Digitar no PC traz o tamanho do terminal de volta para a janela.
  takeTerminal(id: string): void
  onTerminalSize(listener: (event: TerminalSizeEvent) => void): () => void
  onMobileState(listener: (snapshot: DesktopSessionState) => void): () => void
  mobileStatus(): Promise<MobileStatus>
  setMobileEnabled(enabled: boolean): Promise<MobileStatus>
  // Fora de casa: liga e desliga depois de entrar na conta.
  setMobileRemote(enabled: boolean): Promise<MobileStatus>
  // Conta do Fora de casa. Verificar o código e redefinir a senha já entram na conta e ligam o Fora de casa.
  mobileAccount(action: AccountAction): Promise<MobileStatus>
  signOutMobile(): Promise<MobileStatus>
  // Painel do dono do servidor; o relay confere a conta a cada pedido.
  mobileAdmin(request: AdminRequest): Promise<unknown>
  onMobileStatus(listener: (status: MobileStatus) => void): () => void
  pairMobile(): Promise<MobilePairing>
  revokeMobile(id: string): Promise<MobileStatus>
  renameMobile(id: string, name: string): Promise<MobileStatus>
}
