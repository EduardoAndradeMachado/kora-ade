import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Terminals } from './terminals'
import { addProject, applyLayout, relocateProject, missingProjectIds, namedSessions, mergeTabs, removeProject, renameProject, setTabAgent } from './projects'
import { browseMobileFolders, createMobileFolder, isMobileDirectory, mobileDirectory } from './mobile-folders'
import { listProjectSessions } from './sessions'
import { copyEntries, listDir, moveEntry, readText, resolveInside, writeText } from './files'
import { createEntry, renameEntry, trashEntry } from './file-actions'
import { arrangeProjects, moveProjectBy, sortBySection } from '../shared/arrange'
import { moveAmongSiblings, nestGroup, removeGroup, setGroupHidden } from '../shared/groups'
import { gitStatus } from './git'
import { resolveTerminalLink, type ResolvedLink } from './terminal-links'
import { statSync } from 'node:fs'
import { DESKTOP, TerminalSizes, type SizeChange, type TerminalSize } from './terminal-sizes'
import type { AgentActivity, AgentRef } from '../shared/agent'
import type { DayPoint, SessionMetrics } from '../shared/metrics'
import type { TranscriptPage } from '../shared/transcript'
import type { SkillEntry, TranscriptCursor } from './transcript-claude'
import type { KoraState } from '../shared/state'
import type { Launch, TabRef } from '../shared/ipc'
import type { EntryAction, EntryResult, GroupCommand, MobileCommand, MobileDirectory, MobileFileStat, MobileGit, MobileState, MobileUsage } from '../shared/mobile'
import type { TextFile } from '../shared/ipc'
import type { AgentUsage } from '../shared/usage-types'
import type { ClaudeAccountsView } from '../shared/claude-accounts'

const DEFAULT_TITLE = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity', shell: 'Terminal' } as const

export class MobileRuntime {
  readonly sizes = new TerminalSizes()

  constructor(private readonly host: {
    state(): KoraState
    commit(state: KoraState): void
    terminals: Terminals
    activities: Map<string, AgentActivity | null>
    launch(tab: TabRef, cols: number, rows: number, how: Launch): void
    // Mudança de abas ou projetos feita pelo celular: o PC e os outros celulares precisam saber.
    changed(): void
    sized(id: string, change: SizeChange): void
    relocated?(projectId: string, path: string): Promise<void>
    icon?(projectId: string, path: string): Promise<string | null>
    usage?(): Promise<AgentUsage[]>
    metrics?(agent: AgentRef, projectPath: string): Promise<SessionMetrics>
    dayMetrics?(since: number): Promise<DayPoint[]>
    transcript?(agent: AgentRef, projectPath: string, cursor: TranscriptCursor): Promise<TranscriptPage>
    skills?(agent: AgentRef, projectPath: string): Promise<SkillEntry[]>
    accounts?(): Promise<ClaudeAccountsView>
    switchAccount?(id: string): Promise<void>
    dictation?(): boolean
    // O shell.trashItem do Electron: o Excluir do celular manda para a Lixeira do Windows, como o do PC.
    trash?(abs: string): Promise<void>
    // Projeto tirado da lista pelo celular: o PC para de observar a pasta dele.
    removed?(projectId: string): void
    // Pasta listada pelo celular passa a ser observada, como a listada pelo explorador do PC: a mudança chega aos dois.
    watch?(projectId: string, root: string): void
  }) {}

  snapshot(): MobileState {
    const state = this.host.state()
    const running = this.host.terminals.pids()
    return {
      projects: state.projects,
      groups: state.groups,
      missingProjectIds: missingProjectIds(state, isMobileDirectory),
      theme: state.settings.theme,
      alerts: state.settings.alerts,
      dictation: this.host.dictation?.() ?? false,
      tabs: state.tabs.map((tab) => ({ ...tab, live: running.has(tab.id), activity: this.host.activities.get(tab.id) ?? null, holder: this.sizes.holder(tab.id) }))
    }
  }

  sessions(projectId: string): ReturnType<typeof listProjectSessions> {
    const project = this.host.state().projects.find((p) => p.id === projectId)
    if (!project) throw new Error('Projeto desconhecido.')
    return listProjectSessions(join(homedir(), '.claude'), join(homedir(), '.codex'), project.path)
      .then((sessions) => namedSessions(this.host.state(), sessions))
  }

  // Arquivos do projeto pelas mesmas funções do explorador do PC: caminho relativo e nada fora da pasta.
  private projectRoot(projectId: string): string {
    const project = this.host.state().projects.find((p) => p.id === projectId)
    if (!project) throw new Error('Projeto desconhecido.')
    if (!isMobileDirectory(project.path)) throw new Error('A pasta deste projeto não foi encontrada. Revincule a pasta para continuar.')
    return project.path
  }

  files(projectId: string, rel: string): MobileDirectory {
    const root = this.projectRoot(projectId)
    const entries = listDir(root, rel)
    this.host.watch?.(projectId, root)
    return { path: rel, entries }
  }

  // Pasta que não é repositório (ou git ausente no PC) volta sem status, como no explorador do PC.
  async git(projectId: string): Promise<MobileGit> {
    const status = await gitStatus(this.projectRoot(projectId)).catch(() => null)
    return { files: status?.files ?? [] }
  }

  readFile(projectId: string, rel: string): TextFile {
    try {
      return readText(this.projectRoot(projectId), rel)
    } catch (error) {
      // O aviso do PC manda abrir no programa padrão, o que não existe no celular.
      if (error instanceof Error && error.message.startsWith('Arquivo binário')) throw new Error('Este arquivo não é texto e não abre no celular.')
      throw error
    }
  }

  // Lança ConflictError se o arquivo mudou no disco depois de aberto (o agente pode estar editando).
  writeFile(projectId: string, rel: string, content: string, mtimeMs: number): number {
    return writeText(this.projectRoot(projectId), rel, content, mtimeMs)
  }

  async entry(action: EntryAction): Promise<EntryResult> {
    const root = this.projectRoot(action.projectId)
    switch (action.op) {
      case 'create':
        return { path: createEntry(root, action.parent, action.name, action.kind).rel }
      case 'rename':
        return { path: renameEntry(root, action.path, action.name) }
      case 'move':
        return { path: moveEntry(root, action.path, action.to) }
      case 'duplicate': {
        const [copy] = await copyEntries(root, [action.path], dirname(action.path))
        return { path: copy! }
      }
      case 'trash': {
        const trash = this.host.trash
        if (!trash) throw new Error('A Lixeira não está disponível neste PC.')
        await trashEntry(root, action.path, trash)
        return { path: '' }
      }
    }
  }

  // O celular pergunta ao abrir e a cada aviso do observador; abrir também liga o observador do projeto, porque o
  // arquivo pode ter vindo de um link do terminal sem a pasta ter sido listada.
  fileStat(projectId: string, rel: string): MobileFileStat {
    const root = this.projectRoot(projectId)
    const file = resolveInside(root, rel)
    this.host.watch?.(projectId, root)
    try {
      const stat = statSync(file)
      return stat.isFile() ? { exists: true, mtimeMs: stat.mtimeMs, size: stat.size } : { exists: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
      throw error
    }
  }

  filePath(projectId: string, rel: string): string {
    const file = resolveInside(this.projectRoot(projectId), rel)
    if (!statSync(file).isFile()) throw new Error('Não é um arquivo.')
    return file
  }

  async usage(): Promise<MobileUsage> {
    const [usage, view] = await Promise.all([this.host.usage?.() ?? [], this.host.accounts?.() ?? null])
    return { usage, accounts: view?.accounts ?? [], activeUnknown: view?.activeUnknown ?? false }
  }

  // Caminho tocado no terminal do celular: só vira link o arquivo que existe dentro do projeto, como no PC.
  resolveLink(projectId: string, text: string): Promise<ResolvedLink | null> {
    return resolveTerminalLink(this.projectRoot(projectId), text)
  }

  // A mesma leitura do painel de métricas do PC, pela aba: o celular não conhece o caminho do projeto.
  tabMetrics(tabId: string): Promise<SessionMetrics> {
    const tab = this.host.state().tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error('Aba desconhecida.')
    if (!tab.agent) throw new Error('Esta aba é um terminal, sem métricas de IA.')
    if (!this.host.metrics) throw new Error('Métricas indisponíveis neste PC.')
    return this.host.metrics({ kind: tab.agent.kind, sessionId: tab.agent.sessionId }, this.projectRoot(tab.projectId))
  }

  // Só lê o arquivo da conversa: não entra no terminal, então não muda o tamanho dele no PC.
  tabTranscript(tabId: string, cursor: TranscriptCursor): Promise<TranscriptPage> {
    const { agent, root } = this.agentTab(tabId)
    if (!this.host.transcript) throw new Error('Modo leitura indisponível neste PC.')
    return this.host.transcript(agent, root, cursor)
  }

  async tabSkills(tabId: string): Promise<SkillEntry[]> {
    const { agent, root } = this.agentTab(tabId)
    return (await this.host.skills?.(agent, root)) ?? []
  }

  private agentTab(tabId: string): { agent: AgentRef; root: string } {
    const tab = this.host.state().tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error('Aba desconhecida.')
    if (!tab.agent) throw new Error('Esta aba é um terminal, sem conversa para ler.')
    return { agent: { kind: tab.agent.kind, sessionId: tab.agent.sessionId }, root: this.projectRoot(tab.projectId) }
  }

  dayMetrics(since: number): Promise<DayPoint[]> {
    if (!this.host.dayMetrics) throw new Error('Métricas indisponíveis neste PC.')
    return this.host.dayMetrics(since)
  }

  snapshotTerminal(id: string): ReturnType<Terminals['snapshot']> { return this.host.terminals.snapshot(id) }

  folders(path?: string): ReturnType<typeof browseMobileFolders> {
    return browseMobileFolders(path, this.host.state().projects.map((project) => project.path))
  }

  async createFolder(parent: string, name: string): ReturnType<typeof browseMobileFolders> {
    return this.folders(await createMobileFolder(parent, name))
  }

  async projectIcon(id: string): Promise<string | null> {
    const project = this.host.state().projects.find((project) => project.id === id)
    if (!project) throw new Error('Projeto desconhecido.')
    return await this.host.icon?.(project.id, project.path) ?? null
  }

  viewing(device: string, tabId: string): boolean {
    return this.sizes.viewers(tabId).includes(device)
  }

  desktopSize(id: string, size: TerminalSize): void {
    this.apply(id, this.sizes.want(id, DESKTOP, size))
  }

  desktopTake(id: string): void {
    this.apply(id, this.sizes.take(id, DESKTOP))
  }

  // O pty nasce no tamanho de quem abriu; o registro evita que outra tela o redimensione sem ter interagido.
  launched(id: string, client: string, size: TerminalSize): void {
    this.sizes.want(id, client, size)
  }

  leave(device: string): void {
    for (const [id, change] of this.sizes.leaveAll(device)) this.apply(id, change)
  }

  private apply(id: string, change: SizeChange | null): void {
    if (!change) return
    this.host.terminals.resize(id, change.cols, change.rows)
    this.host.sized(id, change)
  }

  private attach(id: string, device: string, size: TerminalSize): void {
    this.sizes.want(id, device, size)
    this.sizes.take(id, device)
    // Reaplica mesmo sem troca de dono: o pty pode ter renascido no tamanho do PC enquanto o celular olhava.
    const current = this.sizes.current(id)
    if (current?.holder === device) this.apply(id, current)
  }

  private live(id: string): void {
    if (!this.host.terminals.pids().has(id)) throw new Error('A sessão está suspensa.')
  }

  // O mesmo caminho do "project:layout" da lateral do PC: as funções da lateral calculam, o applyLayout confere e grava.
  private arrange(projects: KoraState['projects'], groups: KoraState['groups']): void {
    const sorted = sortBySection(projects, groups)
    this.host.commit(applyLayout(this.host.state(), { groups, placements: sorted.map((p) => ({ id: p.id, hidden: Boolean(p.hidden), groupId: p.groupId ?? null })) }))
    this.host.changed()
  }

  private project(id: string): KoraState['projects'][number] {
    const project = this.host.state().projects.find((p) => p.id === id)
    if (!project) throw new Error('Projeto desconhecido.')
    return project
  }

  private group(action: GroupCommand): string | undefined {
    const { projects, groups } = this.host.state()
    if (action.kind === 'create') {
      const created = { id: randomUUID(), name: action.name, ...(action.parentId ? { parentId: action.parentId } : {}) }
      // Criar dentro de uma categoria recolhida a abre, como no PC: senão a nova nem apareceria.
      const opened = action.parentId ? groups.map((g) => (g.id === action.parentId ? { ...g, collapsed: false } : g)) : groups
      this.arrange(projects, [...opened, created])
      return created.id
    }
    if (!groups.some((g) => g.id === action.id)) throw new Error('Categoria não encontrada.')
    switch (action.kind) {
      case 'rename':
        return void this.arrange(projects, groups.map((g) => (g.id === action.id ? { ...g, name: action.name } : g)))
      case 'hide':
        return void this.arrange(projects, setGroupHidden(groups, action.id, action.hidden))
      case 'nest': {
        if (action.parentId && !groups.some((g) => g.id === action.parentId)) throw new Error('Categoria não encontrada.')
        const next = nestGroup(groups, action.id, action.parentId)
        if (next === groups) throw new Error('Uma categoria não pode ficar dentro dela mesma.')
        return void this.arrange(projects, next)
      }
      case 'move':
        return void this.arrange(projects, moveAmongSiblings(groups, action.id, action.delta))
      case 'remove': {
        const next = removeGroup(groups, projects, action.id)
        return void this.arrange(next.projects, next.groups)
      }
    }
  }

  async execute(device: string, command: MobileCommand): Promise<{ tabId?: string; projectId?: string; groupId?: string }> {
    if (command.type === 'group') return { groupId: this.group(command.action) }
    if (command.type === 'place-project' || command.type === 'move-project') {
      this.project(command.projectId)
      const { projects, groups } = this.host.state()
      const section = command.type === 'place-project' ? command.section : null
      if (section && !section.hidden && section.groupId && !groups.some((g) => g.id === section.groupId)) throw new Error('Categoria não encontrada.')
      this.arrange(command.type === 'place-project'
        ? arrangeProjects(projects, command.projectId, { kind: 'section', section: command.section }, groups)
        : moveProjectBy(projects, command.projectId, command.delta, groups), groups)
      return { projectId: command.projectId }
    }
    // Como o "Remover da lista" do PC: fecha os terminais do projeto e desfaz o vínculo; a pasta fica no disco.
    if (command.type === 'remove-project') {
      this.project(command.projectId)
      for (const tab of this.host.state().tabs.filter((t) => t.projectId === command.projectId)) {
        this.host.terminals.kill(tab.id)
        this.sizes.forget(tab.id)
      }
      this.host.commit(removeProject(this.host.state(), command.projectId))
      this.host.removed?.(command.projectId)
      this.host.changed()
      return {}
    }
    if (command.type === 'add-project' || command.type === 'relocate-project') {
      const path = await mobileDirectory(command.path)
      if (command.type === 'relocate-project') {
        const next = relocateProject(this.host.state(), command.projectId, path)
        this.host.commit(next)
        await this.host.relocated?.(command.projectId, path)
        this.host.changed()
        return { projectId: command.projectId }
      }
      const next = addProject(this.host.state(), path)
      this.host.commit(next)
      this.host.changed()
      return { projectId: next.projects.find((project) => project.path.toLowerCase() === path.toLowerCase())!.id }
    }
    if (command.type === 'rename-project') {
      this.host.commit(renameProject(this.host.state(), command.projectId, command.name))
      this.host.changed()
      return { projectId: command.projectId }
    }
    if (command.type === 'switch-account') {
      if (!this.host.switchAccount) throw new Error('Troca de conta indisponível.')
      await this.host.switchAccount(command.accountId)
      return {}
    }
    if (command.type === 'alerts') {
      const state = this.host.state()
      this.host.commit({ ...state, settings: { ...state.settings, alerts: command.alerts } })
      this.host.changed()
      return {}
    }
    if (command.type === 'create' || command.type === 'open-session') {
      const project = this.host.state().projects.find((p) => p.id === command.projectId)
      if (!project) throw new Error('Projeto desconhecido.')
      if (!isMobileDirectory(project.path)) throw new Error('A pasta deste projeto não foi encontrada. Revincule a pasta para continuar.')
      let tab: TabRef = { id: randomUUID(), projectId: project.id, title: command.type === 'create' ? DEFAULT_TITLE[command.kind] : '', titleLocked: false }
      if (command.type === 'open-session') {
        const session = (await this.sessions(project.id)).find((s) => s.kind === command.agent.kind && s.sessionId === command.agent.sessionId)
        if (!session) throw new Error('Conversa não encontrada neste projeto.')
        const existing = this.host.state().tabs.find((t) => t.projectId === project.id && t.agent?.kind === command.agent.kind && t.agent.sessionId === command.agent.sessionId)
        if (existing) return { tabId: existing.id }
        // Como a conversa aberta pelo painel do PC: a aba nasce com o nome da conversa e já ligada a ela.
        tab = { ...tab, title: session.title, titleLocked: session.named === true }
      }
      const merged = mergeTabs(this.host.state(), [...this.host.state().tabs, tab])
      this.host.commit(command.type === 'open-session' ? setTabAgent(merged, tab.id, { kind: command.agent.kind, sessionId: command.agent.sessionId }) : merged)
      const how: Launch = command.type === 'create' ? { type: command.kind } : { type: 'resume', agent: command.agent }
      try {
        this.launched(tab.id, device, command)
        this.host.launch(tab, command.cols, command.rows, how)
      } finally {
        this.host.changed()
      }
      return { tabId: tab.id }
    }
    const tab = this.host.state().tabs.find((t) => t.id === command.tabId)
    if (!tab) throw new Error('Aba não encontrada.')
    switch (command.type) {
      case 'attach':
        this.attach(tab.id, device, command)
        return {}
      case 'detach':
        this.apply(tab.id, this.sizes.leave(tab.id, device))
        return {}
      case 'resize':
        this.apply(tab.id, this.sizes.want(tab.id, device, command))
        return {}
      case 'keys':
        this.live(tab.id)
        this.apply(tab.id, this.sizes.take(tab.id, device))
        this.host.terminals.write(tab.id, command.data)
        return {}
      case 'redraw':
        this.live(tab.id)
        this.host.terminals.redraw(tab.id)
        return {}
      case 'send':
        this.live(tab.id)
        this.apply(tab.id, this.sizes.take(tab.id, device))
        this.host.terminals.submit(tab.id, command.text, tab.agent?.kind, command.images, command.files)
        return {}
      case 'resume':
        if (!this.host.terminals.pids().has(tab.id)) {
          const project = this.host.state().projects.find((project) => project.id === tab.projectId)
          if (!project || !isMobileDirectory(project.path)) throw new Error('A pasta deste projeto não foi encontrada. Revincule a pasta para continuar.')
          this.launched(tab.id, device, command)
          this.host.launch(tab, command.cols, command.rows, tab.agent ? { type: 'resume', agent: tab.agent } : { type: 'shell' })
        }
        break
      case 'suspend':
        this.host.terminals.kill(tab.id)
        break
      case 'close':
        this.host.terminals.kill(tab.id)
        this.host.commit({ ...this.host.state(), tabs: this.host.state().tabs.filter((t) => t.id !== tab.id) })
        this.sizes.forget(tab.id)
        break
      case 'rename':
        this.host.commit(mergeTabs(this.host.state(), this.host.state().tabs.map((t) => t.id === tab.id ? { ...t, title: command.title, titleLocked: true } : t)))
        break
    }
    this.host.changed()
    return {}
  }
}
