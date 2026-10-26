import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import type { MobileState, MobileTab } from '@shared/mobile'
import type { Project, ProjectGroup } from '@shared/state'
import { descendantIds } from '@shared/groups'
import { agentLabel } from '@/components/AgentIcon'
import { MobileProjectAvatar } from './MobileProjectAvatar'
import { TabIcon } from './NewTabSheet'
import { useLongPress } from './longPress'

// Abrir e recolher no celular vale só para ele e sobrevive a sair da lista e reabrir o app; o que nunca foi mexido
// aqui segue o PC. remembered segura a escolha entre uma visita e outra à lista mesmo sem localStorage.
const EXPANDED_KEY = 'kora-tree-expanded'
let remembered: Record<string, boolean> | null = null
const savedExpanded = (): Record<string, boolean> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}')
    return value && typeof value === 'object' ? value as Record<string, boolean> : {}
  } catch { return {} }
}

export const tabStatus = (tab: MobileTab): string => !tab.live ? 'Suspensa' : tab.activity === 'working' ? 'Trabalhando' : 'Aberta'

export function ProjectTree({ state, search, onProject, onFiles, onNewTab, onTab, onTabActions, onRelocate }: {
  state: MobileState
  search: string
  onProject(id: string): void
  onFiles(id: string): void
  onNewTab(projectId: string): void
  onTab(tab: MobileTab): void
  onTabActions(tab: MobileTab): void
  onRelocate(id: string): void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(() => remembered ?? savedExpanded())
  useEffect(() => {
    remembered = expanded
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded)) } catch { /* sem armazenamento, vale até fechar o app */ }
  }, [expanded])
  const longPress = useLongPress()
  const query = search.trim().toLocaleLowerCase('pt-BR')
  const matches = (project: Project): boolean => !query || `${project.name} ${project.path}`.toLocaleLowerCase('pt-BR').includes(query) || state.tabs.some((tab) => tab.projectId === project.id && tab.title.toLocaleLowerCase('pt-BR').includes(query))
  const projectRow = (project: Project): React.JSX.Element | null => {
    if (!matches(project)) return null
    const tabs = state.tabs.filter((tab) => tab.projectId === project.id)
    const open = query ? true : expanded[project.id] ?? !project.collapsed
    const missing = state.missingProjectIds.includes(project.id)
    const toggle = (): void => setExpanded((previous) => ({ ...previous, [project.id]: !open }))
    return <div className={`tree-project ${open ? 'expanded' : ''} ${missing ? 'missing' : ''}`} key={project.id}>
      <div className="tree-project-row">
        <button className={`tree-toggle ${open ? 'expanded' : ''}`} aria-label={`${open ? 'Recolher' : 'Expandir'} ${project.name}`} aria-expanded={open} onClick={toggle}><Icon name="expandir" /></button>
        <button className="tree-project-name" onClick={() => tabs.length ? toggle() : onProject(project.id)}><MobileProjectAvatar id={project.id} path={project.path} open={open} /><strong>{project.name}</strong>{missing && <Icon name="alerta" active />}</button>
        {!open && tabs.length > 0 && <span className="tree-count">{tabs.length}</span>}
        {!missing && <button className="icon-button tree-new" aria-label={`Arquivos de ${project.name}`} onClick={() => onFiles(project.id)}><Icon name="projeto" /></button>}
        <button className="icon-button tree-new" aria-label={`Nova conversa em ${project.name}`} disabled={missing} onClick={() => onNewTab(project.id)}><Icon name="novaAba" /></button>
      </div>
      {missing && <div className="tree-missing"><span>Pasta não encontrada</span><button onClick={() => onRelocate(project.id)}>Revincular<Icon name="mover" active /></button></div>}
      {open && tabs.length > 0 && <div className="tree-tabs">
        {tabs.map((tab) => <button className="tree-tab" key={tab.id} onClick={() => onTab(tab)} {...longPress(() => onTabActions(tab))}>
          <TabIcon tab={tab} /><span><strong>{tab.title || 'Terminal'}</strong><small>{tab.agent ? agentLabel(tab.agent.kind) : 'Terminal'} · {tabStatus(tab)}</small></span>
          <span className={`activity-dot ${tab.live ? tab.activity === 'working' ? 'working' : 'live' : ''}`} aria-label={tabStatus(tab)} />
        </button>)}
        <button className="tree-project-link" onClick={() => onProject(project.id)}><Icon name="sessoes" />Conversas e novas abas<Icon name="expandir" /></button>
        {!missing && <button className="tree-project-link" onClick={() => onFiles(project.id)}><Icon name="arquivo" />Arquivos do projeto<Icon name="expandir" /></button>}
      </div>}
    </div>
  }
  // Mesma conta da lateral do PC: projetos visíveis da categoria e das subcategorias.
  const projectsIn = (groupId: string): number => {
    const inside = descendantIds(state.groups, groupId)
    return state.projects.filter((project) => !project.hidden && project.groupId && (project.groupId === groupId || inside.has(project.groupId))).length
  }
  const hasMatches = (group: ProjectGroup): boolean => state.projects.some((project) => project.groupId === group.id && matches(project)) || state.groups.some((child) => child.parentId === group.id && hasMatches(child))
  const groupRow = (group: ProjectGroup): React.JSX.Element | null => {
    if (query && !hasMatches(group)) return null
    const open = query ? true : expanded[group.id] ?? !group.collapsed
    return <section className="tree-group" key={group.id}>
      <button className={`group-heading ${open ? 'expanded' : ''}`} aria-expanded={open} onClick={() => setExpanded((previous) => ({ ...previous, [group.id]: !open }))}><Icon name="expandir" /><span>{group.name}</span><span className="tree-count">{projectsIn(group.id)}</span></button>
      {open && <div className="group-content">{state.projects.filter((project) => !project.hidden && project.groupId === group.id).map(projectRow)}{state.groups.filter((child) => child.parentId === group.id).map(groupRow)}</div>}
    </section>
  }
  const hiddenProjects = state.projects.filter((project) => project.hidden)
  const hiddenGroups = state.groups.filter((group) => !group.parentId && group.hidden)
  const hiddenCount = hiddenProjects.length + hiddenGroups.reduce((sum, group) => sum + projectsIn(group.id), 0)
  const hiddenOpen = query ? true : expanded.__hidden ?? false
  return <div className="project-tree">
    {state.projects.filter((project) => !project.hidden && !project.groupId).map(projectRow)}
    {state.groups.filter((group) => !group.parentId && !group.hidden).map(groupRow)}
    {(hiddenProjects.length > 0 || hiddenGroups.length > 0) && <section className="tree-group hidden-projects"><button className={`group-heading ${hiddenOpen ? 'expanded' : ''}`} aria-expanded={hiddenOpen} onClick={() => setExpanded((previous) => ({ ...previous, __hidden: !hiddenOpen }))}><Icon name="expandir" /><span>Ocultos</span><span className="tree-count">{hiddenCount}</span></button>{hiddenOpen && <div className="group-content">{hiddenProjects.map(projectRow)}{hiddenGroups.map(groupRow)}</div>}</section>}
    {query && !state.projects.some(matches) && <p className="empty-copy">Nenhum projeto ou aba encontrado.</p>}
  </div>
}
