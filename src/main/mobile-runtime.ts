import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Terminals } from './terminals'
import { addProject, relocateProject, missingProjectIds, namedSessions, mergeTabs } from './projects'
import { browseMobileFolders, isMobileDirectory, mobileDirectory } from './mobile-folders'
import { listProjectSessions } from './sessions'
import { DESKTOP, TerminalSizes, type SizeChange, type TerminalSize } from './terminal-sizes'
import type { AgentActivity } from '../shared/agent'
import type { KoraState } from '../shared/state'
import type { Launch, TabRef } from '../shared/ipc'
import type { MobileCommand, MobileState, MobileUsage } from '../shared/mobile'
import type { AgentUsage } from '../shared/usage-types'
import type { ClaudeAccountsView } from '../shared/claude-accounts'

const DEFAULT_TITLE = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', shell: 'Terminal' } as const

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
    accounts?(): Promise<ClaudeAccountsView>
    switchAccount?(id: string): Promise<void>
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
      tabs: state.tabs.map((tab) => ({ ...tab, live: running.has(tab.id), activity: this.host.activities.get(tab.id) ?? null, holder: this.sizes.holder(tab.id) }))
    }
  }

  sessions(projectId: string): ReturnType<typeof listProjectSessions> {
    const project = this.host.state().projects.find((p) => p.id === projectId)
    if (!project) throw new Error('Projeto desconhecido.')
    return listProjectSessions(join(homedir(), '.claude'), join(homedir(), '.codex'), project.path)
      .then((sessions) => namedSessions(this.host.state(), sessions))
  }

  async usage(): Promise<MobileUsage> {
    const [usage, view] = await Promise.all([this.host.usage?.() ?? [], this.host.accounts?.() ?? null])
    return { usage, accounts: view?.accounts ?? [], activeUnknown: view?.activeUnknown ?? false }
  }

  snapshotTerminal(id: string): ReturnType<Terminals['snapshot']> { return this.host.terminals.snapshot(id) }

  folders(path?: string): ReturnType<typeof browseMobileFolders> {
    return browseMobileFolders(path, this.host.state().projects.map((project) => project.path))
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

  async execute(device: string, command: MobileCommand): Promise<{ tabId?: string; projectId?: string }> {
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
      if (command.type === 'open-session') {
        const available = await this.sessions(project.id)
        if (!available.some((s) => s.kind === command.agent.kind && s.sessionId === command.agent.sessionId)) {
          throw new Error('Conversa não encontrada neste projeto.')
        }
        const existing = this.host.state().tabs.find((t) => t.projectId === project.id && t.agent?.kind === command.agent.kind && t.agent.sessionId === command.agent.sessionId)
        if (existing) return { tabId: existing.id }
      }
      const tab: TabRef = { id: randomUUID(), projectId: project.id, title: command.type === 'create' ? DEFAULT_TITLE[command.kind] : 'Conversa retomada', titleLocked: false }
      this.host.commit(mergeTabs(this.host.state(), [...this.host.state().tabs, tab]))
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
      case 'send':
        this.live(tab.id)
        this.apply(tab.id, this.sizes.take(tab.id, device))
        this.host.terminals.submit(tab.id, command.text, tab.agent?.kind, command.images)
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
