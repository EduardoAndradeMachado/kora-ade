import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { KoraState, ProjectGroup, SavedTab } from '../shared/state'
import { descendantIds } from '../shared/groups'

const samePath = (a: string, b: string): boolean =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase()

export function addProject(state: KoraState, path: string): KoraState {
  if (state.projects.some((p) => samePath(p.path, path))) return state
  const project = { id: randomUUID(), name: basename(resolve(path)) || path, path: resolve(path) }
  return { ...state, projects: [...state.projects, project] }
}

export function removeProject(state: KoraState, id: string): KoraState {
  return {
    ...state,
    projects: state.projects.filter((p) => p.id !== id),
    tabs: state.tabs.filter((t) => t.projectId !== id)
  }
}

export interface ProjectPlacement {
  id: string
  hidden: boolean
  groupId: string | null
}

export interface SidebarLayout {
  groups: ProjectGroup[]
  placements: ProjectPlacement[]
}

// Só organiza (ordem, categoria, oculto): a lista que chega do renderer tem que ter exatamente os mesmos
// projetos, e toda categoria usada precisa existir. Nome e caminho continuam os do estado salvo.
export function applyLayout(state: KoraState, layout: SidebarLayout): KoraState {
  const byId = new Map(state.projects.map((p) => [p.id, p]))
  const ids = new Set(layout.placements.map((p) => p.id))
  if (ids.size !== layout.placements.length || ids.size !== byId.size || layout.placements.some((p) => !byId.has(p.id))) {
    throw new Error('Ordem de projetos não corresponde aos projetos salvos')
  }
  const groupIds = new Set(layout.groups.map((g) => g.id))
  if (groupIds.size !== layout.groups.length) throw new Error('Categoria repetida')
  if (layout.groups.some((g) => g.parentId && (!groupIds.has(g.parentId) || descendantIds(layout.groups, g.id).has(g.parentId)))) {
    throw new Error('Categoria dentro de uma categoria que não existe ou dentro dela mesma')
  }
  if (layout.placements.some((p) => p.groupId !== null && !groupIds.has(p.groupId))) throw new Error('Projeto numa categoria que não existe')
  const projects = layout.placements.map(({ id, hidden, groupId }) => {
    const { hidden: _hidden, groupId: _groupId, ...rest } = byId.get(id)!
    return groupId && !hidden ? { ...rest, hidden, groupId } : { ...rest, hidden }
  })
  return { ...state, groups: layout.groups, projects }
}

// O renderer manda a ordem e os títulos das abas; a sessão detectada é do main e não pode ser
// apagada por um save do renderer que ainda não recebeu a detecção.
export function mergeTabs(
  state: KoraState,
  incoming: { id: string; projectId: string; title: string; titleLocked?: boolean }[]
): KoraState {
  const known = new Map(state.tabs.map((t) => [t.id, t]))
  const projectIds = new Set(state.projects.map((p) => p.id))
  const tabs = incoming
    .filter((t) => projectIds.has(t.projectId))
    .map((t) => ({
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      titleLocked: t.titleLocked ?? false,
      agent: known.get(t.id)?.agent ?? null
    }))
  return { ...state, tabs }
}

export function setTabAgent(state: KoraState, tabId: string, agent: SavedTab['agent']): KoraState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, agent } : t)) }
}
