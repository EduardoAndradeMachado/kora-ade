// Categorias formam uma árvore: `parentId` aponta para a categoria de cima. A ordem entre irmãs é a ordem no array.
// Só a categoria da raiz pode estar em Ocultos; as de dentro vão junto com ela.
export interface GroupNode {
  id: string
  name?: string
  parentId?: string
  hidden?: boolean
  collapsed?: boolean
}

// Categoria cuja mãe não existe mais sobe para a raiz: nada some da lateral.
export function parentOf<T extends GroupNode>(groups: T[], group: T): string | null {
  return group.parentId && groups.some((g) => g.id === group.parentId) ? group.parentId : null
}

export function childrenOf<T extends GroupNode>(groups: T[], parentId: string | null): T[] {
  return groups.filter((g) => parentOf(groups, g) === parentId)
}

export function descendantIds<T extends GroupNode>(groups: T[], id: string): Set<string> {
  const found = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const current = stack.pop()!
    for (const child of childrenOf(groups, current)) {
      if (found.has(child.id) || child.id === id) continue
      found.add(child.id)
      stack.push(child.id)
    }
  }
  return found
}

function rootOf<T extends GroupNode>(groups: T[], id: string): T | undefined {
  let current = groups.find((g) => g.id === id)
  const seen = new Set<string>()
  while (current) {
    const parent = parentOf(groups, current)
    if (!parent || seen.has(parent)) return current
    seen.add(current.id)
    current = groups.find((g) => g.id === parent)
  }
  return undefined
}

export function isInHidden<T extends GroupNode>(groups: T[], id: string): boolean {
  return Boolean(rootOf(groups, id)?.hidden)
}

// Ordem de desenho em profundidade: a categoria, depois as de dentro dela, depois a próxima irmã.
export function drawOrder<T extends GroupNode>(groups: T[]): { visible: T[]; hidden: T[] } {
  const walk = (parentId: string | null, out: T[]): void => {
    for (const g of childrenOf(groups, parentId)) {
      out.push(g)
      walk(g.id, out)
    }
  }
  const visible: T[] = []
  const hidden: T[] = []
  for (const root of childrenOf(groups, null)) {
    const out = root.hidden ? hidden : visible
    out.push(root)
    walk(root.id, out)
  }
  return { visible, hidden }
}

export function depthOf<T extends GroupNode>(groups: T[], id: string): number {
  let depth = 0
  let current = groups.find((g) => g.id === id)
  const seen = new Set<string>()
  while (current) {
    const parent = parentOf(groups, current)
    if (!parent || seen.has(parent)) break
    seen.add(parent)
    depth++
    current = groups.find((g) => g.id === parent)
  }
  return depth
}

// Coloca a categoria dentro de outra (ou na raiz com null). Recusa colocá-la dentro dela mesma ou de uma filha.
export function nestGroup<T extends GroupNode>(groups: T[], id: string, parentId: string | null): T[] {
  if (parentId === id || (parentId && descendantIds(groups, id).has(parentId))) return groups
  if (!groups.some((g) => g.id === id) || (parentId && !groups.some((g) => g.id === parentId))) return groups
  const moving = groups.find((g) => g.id === id)!
  const { parentId: _parentId, hidden: _hidden, ...rest } = moving
  const placed = (parentId ? { ...rest, parentId } : { ...rest, hidden: false }) as T
  return [...groups.filter((g) => g.id !== id), placed]
}

// Ocultar leva a categoria (com tudo dentro) para a raiz de Ocultos; mostrar a traz de volta para a raiz.
export function setGroupHidden<T extends GroupNode>(groups: T[], id: string, hidden: boolean): T[] {
  return groups.map((g) => {
    if (g.id !== id) return g
    const { parentId: _parentId, ...rest } = g
    return { ...rest, hidden } as T
  })
}

// Sobe ou desce entre as irmãs (mesma categoria de cima), sem pular para outro nível.
export function moveAmongSiblings<T extends GroupNode>(groups: T[], id: string, delta: -1 | 1): T[] {
  const group = groups.find((g) => g.id === id)
  if (!group) return groups
  const siblings = childrenOf(groups, parentOf(groups, group))
  const position = siblings.indexOf(group)
  const other = siblings[position + delta]
  if (!other) return groups
  const next = [...groups]
  const a = next.indexOf(group)
  const b = next.indexOf(other)
  ;[next[a], next[b]] = [next[b]!, next[a]!]
  return next
}

// Excluir só tira a divisória: projetos e subcategorias sobem um nível (para a categoria de cima ou para a raiz).
export function removeGroup<T extends GroupNode, P extends { groupId?: string }>(
  groups: T[],
  projects: P[],
  id: string
): { groups: T[]; projects: P[] } {
  const group = groups.find((g) => g.id === id)
  if (!group) return { groups, projects }
  const parent = parentOf(groups, group)
  const lift = <X extends object>(item: X, key: keyof X): X => {
    const { [key]: _removed, ...rest } = item
    return (parent ? { ...rest, [key]: parent } : rest) as X
  }
  return {
    groups: groups
      .filter((g) => g.id !== id)
      .map((g) => (g.parentId === id ? (group.hidden && !parent ? { ...lift(g, 'parentId'), hidden: true } : lift(g, 'parentId')) : g)),
    projects: projects.map((p) => (p.groupId === id ? lift(p, 'groupId') : p))
  }
}

// Coloca a categoria antes ou depois de outra, como irmã dela: mesmo nível e, na raiz, mesma seção (visível ou Ocultos).
export function placeGroup<T extends GroupNode>(groups: T[], id: string, targetId: string, place: 'before' | 'after'): T[] {
  const target = groups.find((g) => g.id === targetId)
  const moving = groups.find((g) => g.id === id)
  if (!target || !moving || id === targetId || descendantIds(groups, id).has(targetId)) return groups
  const parent = parentOf(groups, target)
  const { parentId: _parentId, hidden: _hidden, ...rest } = moving
  const placed = (parent ? { ...rest, parentId: parent } : { ...rest, hidden: Boolean(target.hidden) }) as T
  const others = groups.filter((g) => g.id !== id)
  const index = others.indexOf(target) + (place === 'after' ? 1 : 0)
  return [...others.slice(0, index), placed, ...others.slice(index)]
}
