import { drawOrder, type GroupNode } from './groups'

export type Place = 'before' | 'after'

export function reorder<T extends { id: string }>(list: T[], fromId: string, toId: string, place: Place): T[] {
  if (fromId === toId) return list
  const moving = list.find((item) => item.id === fromId)
  if (!moving || !list.some((item) => item.id === toId)) return list
  const rest = list.filter((item) => item.id !== fromId)
  const index = rest.findIndex((item) => item.id === toId) + (place === 'after' ? 1 : 0)
  return [...rest.slice(0, index), moving, ...rest.slice(index)]
}

interface Arrangeable {
  id: string
  hidden?: boolean
  groupId?: string
}

// Onde o projeto aparece na lateral: sem categoria, numa categoria ou em Ocultos.
export type Section = { hidden: true } | { hidden: false; groupId: string | null }
export type ProjectDrop = { kind: 'project'; id: string; place: Place } | { kind: 'section'; section: Section }

const HIDDEN = 'hidden'
const NONE = 'none'

function sectionKey(project: Arrangeable): string {
  if (project.hidden) return HIDDEN
  return project.groupId ? `g:${project.groupId}` : NONE
}

function sectionOf(project: Arrangeable, groupIds: ReadonlySet<string>): Section {
  if (project.hidden) return { hidden: true }
  return { hidden: false, groupId: project.groupId && groupIds.has(project.groupId) ? project.groupId : null }
}

function placedIn<T extends Arrangeable>(project: T, section: Section): T {
  const { hidden: _hidden, groupId: _groupId, ...rest } = project
  if (section.hidden) return { ...rest, hidden: true } as T
  return (section.groupId ? { ...rest, hidden: false, groupId: section.groupId } : { ...rest, hidden: false }) as T
}

export type GroupRef = GroupNode

// A lista sai sempre na ordem em que a lateral desenha: sem categoria, categorias visíveis (em profundidade), e em
// Ocultos os projetos soltos seguidos das categorias ocultas. Categoria que não existe mais conta como "sem categoria".
export function sortBySection<T extends Arrangeable>(projects: T[], groups: GroupRef[]): T[] {
  const { visible, hidden } = drawOrder(groups)
  const rank = new Map<string, number>([
    [NONE, 0],
    ...visible.map((g, i): [string, number] => [`g:${g.id}`, i + 1]),
    [HIDDEN, visible.length + 1],
    ...hidden.map((g, i): [string, number] => [`g:${g.id}`, visible.length + 2 + i])
  ])
  return projects
    .map((project, index) => ({ project, index, rank: rank.get(sectionKey(project)) ?? 0 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ project }) => project)
}

// O projeto vai para a seção do alvo: soltar sobre um projeto (ou num cabeçalho de seção) muda a categoria dele junto.
export function arrangeProjects<T extends Arrangeable>(projects: T[], draggedId: string, drop: ProjectDrop, groups: GroupRef[]): T[] {
  const dragged = projects.find((p) => p.id === draggedId)
  if (!dragged) return projects
  const ids = new Set(groups.map((g) => g.id))
  const target = drop.kind === 'project' ? projects.find((p) => p.id === drop.id) : undefined
  if (drop.kind === 'project' && !target) return projects
  const section = target ? sectionOf(target, ids) : (drop as { section: Section }).section
  const moved = placedIn(dragged, section)
  const rest = projects.filter((p) => p.id !== draggedId)
  let placed: T[]
  if (drop.kind === 'project') {
    const index = rest.findIndex((p) => p.id === drop.id) + (drop.place === 'after' ? 1 : 0)
    placed = [...rest.slice(0, index), moved, ...rest.slice(index)]
  } else {
    // No fim da lista: a ordenação por seção põe o projeto no fim da seção de destino.
    placed = [...rest, moved]
  }
  return sortBySection(placed, groups)
}

// Excluir a categoria só tira a divisória: os projetos dela voltam para "sem categoria".
export function ungroup<T extends Arrangeable>(projects: T[], groupId: string): T[] {
  return projects.map((p) => {
    if (p.groupId !== groupId) return p
    const { groupId: _groupId, ...rest } = p
    return rest as T
  })
}

export function moveBy<T extends { id: string }>(list: T[], id: string, delta: -1 | 1): T[] {
  const index = list.findIndex((item) => item.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= list.length) return list
  const next = [...list]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}
