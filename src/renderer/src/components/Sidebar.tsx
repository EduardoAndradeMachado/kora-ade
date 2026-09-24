import { useEffect, useState } from 'react'
import { GROUP_NAME_MAX, type Project, type ProjectGroup, type ThemePreference } from '@shared/state'
import { childrenOf, depthOf, descendantIds, drawOrder } from '@shared/groups'
import { isDormant, TabIcon, type RenameRequest, type Tab } from '@/components/TabBar'
import { NewTabMenu, type NewTabChoice } from '@/components/NewTabMenu'
import { EditableTitle } from '@/components/EditableTitle'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { ProjectAvatar } from '@/components/ProjectAvatar'
import { UsageFooter } from '@/components/UsageFooter'
import { SizeControl } from '@/components/SizeControl'
import { UpdateBanner } from '@/components/UpdateBanner'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/brand/icons'
import { Wordmark } from '@/brand/Logo'
import { hintClass, mergeDragHandlers, mimeFor, useReorderDrag } from '@/lib/drag'
import type { Place, ProjectDrop } from '@shared/arrange'

export type GroupAction =
  | { kind: 'create'; name: string; parentId: string | null }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'hide'; id: string; hidden: boolean }
  | { kind: 'nest'; id: string; parentId: string | null }
  | { kind: 'place'; id: string; targetId: string; place: 'before' | 'after' }
  | { kind: 'move'; id: string; delta: -1 | 1 }
  | { kind: 'remove'; id: string }

interface Props {
  projects: Project[]
  groups: ProjectGroup[]
  onGroupAction(action: GroupAction): void
  tabs: Record<string, Tab[]>
  selectedId: string | null
  activeTab: Record<string, string | undefined>
  onSelectProject(id: string): void
  onSelectTab(projectId: string, tabId: string): void
  onCloseTab(projectId: string, tabId: string): void
  onRenameTab(projectId: string, tabId: string, title: string): void
  onTabContextMenu(projectId: string, tabId: string, x: number, y: number): void
  renameRequest: RenameRequest | null
  onNewTab(project: Project, choice: NewTabChoice): void
  onAdd(): void
  onRemove(project: Project): void
  onArrangeProject(draggedId: string, drop: ProjectDrop): void
  onReorderTab(projectId: string, fromId: string, toId: string, place: Place): void
  theme: ThemePreference
  onSetTheme(theme: ThemePreference): void
  zoom: number
  terminalFontSize: number
  fileFontSize: number
  onZoom(step: 1 | -1 | 0): void
  onTerminalFont(step: 1 | -1 | 0): void
  onFileFont(step: 1 | -1 | 0): void
}

const THEMES: { theme: ThemePreference; label: string; icon: IconName }[] = [
  { theme: 'system', label: 'Sistema', icon: 'temaSistema' },
  { theme: 'light', label: 'Claro', icon: 'temaClaro' },
  { theme: 'dark', label: 'Escuro', icon: 'temaEscuro' }
]

const iconButton =
  'rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground'

const HIDDEN_OPEN_KEY = 'kora.sidebar.ocultosAbertos'
function readHiddenOpen(): boolean {
  try {
    return localStorage.getItem(HIDDEN_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function Sidebar(props: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; project: Project } | null>(null)
  const [iconVersion, setIconVersion] = useState<Record<string, number>>({})
  const [themeMenu, setThemeMenu] = useState<{ x: number; y: number } | null>(null)
  const [hiddenOpen, setHiddenOpen] = useState(readHiddenOpen)
  const projectDrag = useReorderDrag('projects', 'y', (dragged, target, place) =>
    props.onArrangeProject(dragged, { kind: 'project', id: target, place })
  )
  const activeZone = useReorderDrag('projects', 'y', () => {})
  const rootGroupZone = useReorderDrag('groups', 'y', () => {})
  const hiddenGroupZone = useReorderDrag('groups', 'y', () => {})
  const [creatingIn, setCreatingIn] = useState<{ parentId: string | null } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: ProjectGroup } | null>(null)
  const [renameGroup, setRenameGroup] = useState<{ id: string; n: number } | null>(null)
  const [dragging, setDragging] = useState<'projects' | 'groups' | null>(null)

  // Durante o arrasto o cabeçalho "Projetos" vira a faixa "solte aqui": tirar da categoria não depende de adivinhar o alvo.
  // Fica por cima do cabeçalho, sem empurrar a lista, para o alvo não fugir do mouse no meio do arrasto.
  useEffect(() => {
    const start = (e: DragEvent): void => {
      const types = e.dataTransfer?.types ?? []
      setDragging(types.includes(mimeFor('groups')) ? 'groups' : types.includes(mimeFor('projects')) ? 'projects' : null)
    }
    const end = (): void => setDragging(null)
    document.addEventListener('dragstart', start)
    document.addEventListener('dragend', end)
    document.addEventListener('drop', end)
    return () => {
      document.removeEventListener('dragstart', start)
      document.removeEventListener('dragend', end)
      document.removeEventListener('drop', end)
    }
  }, [])

  const toggleHidden = (): void => {
    const next = !hiddenOpen
    setHiddenOpen(next)
    try {
      localStorage.setItem(HIDDEN_OPEN_KEY, next ? '1' : '0')
    } catch {
      // Sem armazenamento a seção só não lembra o estado na próxima abertura.
    }
  }

  // Uma entrada por categoria, na ordem da lateral, recuada pelo nível; a categoria atual do projeto fica de fora.
  const moveTargets = (project: Project): MenuItem[] => {
    const { visible, hidden } = drawOrder(props.groups)
    const items: MenuItem[] = [...visible, ...hidden]
      .filter((g) => g.id !== project.groupId || project.hidden)
      .map((g) => ({
        label: `Mover para ${'· '.repeat(depthOf(props.groups, g.id))}${g.name}`,
        onSelect: () => props.onArrangeProject(project.id, { kind: 'section', section: { hidden: false, groupId: g.id } })
      }))
    if (project.groupId && !project.hidden) {
      items.push({
        label: 'Tirar da categoria',
        onSelect: () => props.onArrangeProject(project.id, { kind: 'section', section: { hidden: false, groupId: null } })
      })
    }
    return items.length ? ['separator', ...items] : []
  }

  const groupMenuItems = (group: ProjectGroup): MenuItem[] => {
    const nested = Boolean(group.parentId && props.groups.some((g) => g.id === group.parentId))
    return [
      { label: 'Nova subcategoria', onSelect: () => setCreatingIn({ parentId: group.id }) },
      { label: 'Renomear', onSelect: () => setRenameGroup((r) => ({ id: group.id, n: (r?.n ?? 0) + 1 })) },
      'separator',
      { label: 'Mover para cima', onSelect: () => props.onGroupAction({ kind: 'move', id: group.id, delta: -1 }) },
      { label: 'Mover para baixo', onSelect: () => props.onGroupAction({ kind: 'move', id: group.id, delta: 1 }) },
      ...(nested ? [{ label: 'Tirar da categoria de cima', onSelect: () => props.onGroupAction({ kind: 'nest', id: group.id, parentId: null }) }] : []),
      {
        label: group.hidden && !nested ? 'Mostrar categoria' : 'Ocultar categoria',
        onSelect: () => props.onGroupAction({ kind: 'hide', id: group.id, hidden: !(group.hidden && !nested) })
      },
      'separator',
      { label: 'Excluir categoria', danger: true, onSelect: () => props.onGroupAction({ kind: 'remove', id: group.id }) }
    ]
  }

  const creator = (parentId: string | null, depth: number): React.ReactNode =>
    creatingIn?.parentId === parentId && (
      <div style={{ paddingLeft: 4 + depth * 12 }} className="flex h-7 items-center gap-1 pr-1.5">
        <Icon name="expandir" className="size-3.5 text-muted-foreground" />
        <input
          autoFocus
          maxLength={GROUP_NAME_MAX}
          placeholder={parentId ? 'nome da subcategoria' : 'nome da categoria'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const name = e.currentTarget.value.trim()
              setCreatingIn(null)
              if (name) props.onGroupAction({ kind: 'create', name, parentId })
            }
            if (e.key === 'Escape') setCreatingIn(null)
          }}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim()
            setCreatingIn(null)
            if (name) props.onGroupAction({ kind: 'create', name, parentId })
          }}
          className="min-w-0 flex-1 rounded-sm bg-card px-1 text-xs text-foreground outline-none ring-1 ring-ring select-text"
        />
      </div>
    )

  const projectMenu = (project: Project): MenuItem[] => [
    { label: 'Nova aba Claude', onSelect: () => props.onNewTab(project, 'claude') },
    { label: 'Nova aba Codex', onSelect: () => props.onNewTab(project, 'codex') },
    { label: 'Novo terminal', onSelect: () => props.onNewTab(project, 'shell') },
    'separator',
    {
      label: 'Atualizar ícone',
      onSelect: () =>
        void window.kora
          .refreshProjectIcon(project.id)
          .then(() => setIconVersion((v) => ({ ...v, [project.id]: (v[project.id] ?? 0) + 1 })))
    },
    { label: 'Abrir no Explorer', onSelect: () => void window.kora.revealInExplorer(project.id, '') },
    { label: 'Copiar caminho', onSelect: () => void navigator.clipboard.writeText(project.path) },
    'separator',
    {
      label: project.hidden ? 'Mover para Ativos' : 'Ocultar',
      onSelect: () =>
        props.onArrangeProject(project.id, {
          kind: 'section',
          section: project.hidden ? { hidden: false, groupId: null } : { hidden: true }
        })
    },
    ...moveTargets(project),
    'separator',
    { label: 'Remover da lista', danger: true, onSelect: () => props.onRemove(project) }
  ]

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderProject = (project: Project, depth = 0): React.JSX.Element => {
    const selected = project.id === props.selectedId
    const tabs = props.tabs[project.id] ?? []
    const open = !collapsed.has(project.id)
    return (
      <div key={project.id} className="mb-0.5" style={depth ? { marginLeft: depth * 12 } : undefined}>
        <div
          title={project.path}
          data-project-row
          {...projectDrag.itemProps(project.id)}
          // Com abas, o nome faz o mesmo que a setinha; sem abas, selecionar já mostra a tela para abrir Claude, Codex ou Terminal.
          onClick={() => {
            props.onSelectProject(project.id)
            if (tabs.length > 0) toggle(project.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, project })
          }}
          className={cn(
            'group flex h-8 cursor-default items-center gap-1 rounded-md pl-0.5 pr-1.5 text-[13px]',
            selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            selected && tabs.length === 0 && 'bg-secondary',
            hintClass(projectDrag.hint, project.id, 'y')
          )}
        >
          <button
            type="button"
            title={open ? 'Recolher' : 'Expandir'}
            onClick={(e) => {
              e.stopPropagation()
              toggle(project.id)
            }}
            className={cn(iconButton, tabs.length === 0 && 'invisible')}
          >
            <Icon name="expandir" className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          <ProjectAvatar projectId={project.id} version={iconVersion[project.id] ?? 0} />
          <span className="flex-1 truncate font-medium">{project.name}</span>
          {!open && tabs.length > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground group-hover:hidden">
              {tabs.length}
            </span>
          )}
          <div className="hidden items-center gap-0.5 group-hover:flex">
            <NewTabMenu
              onChoose={(choice) => props.onNewTab(project, choice)}
              className={iconButton}
              iconClassName="size-3.5"
            />
          </div>
        </div>

        {open && (
          <SideTabs
            project={project}
            tabs={tabs}
            selected={selected}
            activeTabId={props.activeTab[project.id]}
            renameRequest={props.renameRequest}
            onSelect={(tabId) => props.onSelectTab(project.id, tabId)}
            onClose={(tabId) => props.onCloseTab(project.id, tabId)}
            onRename={(tabId, title) => props.onRenameTab(project.id, tabId, title)}
            onContextMenu={(tabId, x, y) => props.onTabContextMenu(project.id, tabId, x, y)}
            onReorder={(fromId, toId, place) => props.onReorderTab(project.id, fromId, toId, place)}
          />
        )}
      </div>
    )
  }

  const groupIds = new Set(props.groups.map((g) => g.id))
  const ungrouped = props.projects.filter((p) => !p.hidden && !(p.groupId && groupIds.has(p.groupId)))
  const hiddenSolo = props.projects.filter((p) => p.hidden)
  const roots = childrenOf(props.groups, null)
  const hiddenRoots = roots.filter((g) => g.hidden)
  const hiddenGroupProjects = props.projects.filter(
    (p) => !p.hidden && p.groupId && hiddenRoots.some((r) => r.id === p.groupId || descendantIds(props.groups, r.id).has(p.groupId!))
  )
  const hiddenCount = hiddenSolo.length + hiddenGroupProjects.length

  const section = (group: ProjectGroup, depth: number): React.JSX.Element => (
    <GroupSection
      key={group.id}
      group={group}
      groups={props.groups}
      projects={props.projects}
      depth={depth}
      renderProject={renderProject}
      renderSection={section}
      creator={creator}
      renameRequest={renameGroup?.id === group.id ? renameGroup.n : undefined}
      onAction={props.onGroupAction}
      onArrangeProject={props.onArrangeProject}
      onMenu={(x, y) => setGroupMenu({ x, y, group })}
    />
  )

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
      <div className="window-drag flex h-10 items-center px-3">
        <Wordmark height={26} />
      </div>

      <div
        {...mergeDragHandlers(
          activeZone.zoneProps((id) => props.onArrangeProject(id, { kind: 'section', section: { hidden: false, groupId: null } })),
          rootGroupZone.zoneProps((id) => props.onGroupAction({ kind: 'nest', id, parentId: null }))
        )}
        className={cn(
          'relative flex items-center justify-between px-3 pb-1 pt-2',
          (activeZone.zoneActive || rootGroupZone.zoneActive) && 'bg-secondary'
        )}
      >
        {dragging && props.groups.length > 0 && (
          <div
            data-root-drop
            className={cn(
              'pointer-events-none absolute inset-x-2 inset-y-0.5 z-10 flex items-center justify-center rounded-md border-[1.5px] border-dashed border-[var(--brand-amber)] bg-background text-[11px] text-muted-foreground',
              (activeZone.zoneActive || rootGroupZone.zoneActive) && 'bg-secondary font-medium text-[var(--brand-amber)]'
            )}
          >
            {dragging === 'groups' ? 'Solte aqui para virar categoria principal' : 'Solte aqui para tirar da categoria'}
          </div>
        )}
        <span className="text-xs font-medium text-muted-foreground">Projetos</span>
        <div className="flex items-center gap-0.5">
          <button type="button" title="Nova categoria" onClick={() => setCreatingIn({ parentId: null })} className={iconButton}>
            <Icon name="novaCategoria" />
          </button>
          <button type="button" title="Adicionar projeto" onClick={props.onAdd} className={iconButton}>
            <Icon name="novoProjeto" />
          </button>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {props.projects.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Nenhum projeto ainda. Use o botão acima para adicionar uma pasta.
          </p>
        )}

        {ungrouped.map((p) => renderProject(p))}
        {roots.filter((g) => !g.hidden).map((g) => section(g, 0))}
        {creator(null, 0)}

        {props.projects.length > 0 && (
          <div
            {...mergeDragHandlers(
              projectDrag.zoneProps((id) => props.onArrangeProject(id, { kind: 'section', section: { hidden: true } })),
              hiddenGroupZone.zoneProps((id) => props.onGroupAction({ kind: 'hide', id, hidden: true }))
            )}
            role="button"
            title={hiddenOpen ? 'Recolher ocultos' : 'Expandir ocultos'}
            onClick={toggleHidden}
            className={cn(
              'mt-2 flex h-7 cursor-default items-center gap-1 rounded-md pl-0.5 pr-1.5 text-xs text-muted-foreground hover:text-foreground',
              (projectDrag.zoneActive || hiddenGroupZone.zoneActive) &&
                'bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--brand-amber)]'
            )}
          >
            <span className="p-0.5">
              <Icon name="expandir" className={cn('size-3.5 transition-transform', hiddenOpen && 'rotate-90')} />
            </span>
            <span className="font-medium">Ocultos</span>
            <span className="tabular-nums">{hiddenCount}</span>
            <div className="ml-1 h-px flex-1 bg-border" />
          </div>
        )}
        {hiddenOpen &&
          (hiddenSolo.length > 0 || hiddenRoots.length > 0 ? (
            <>
              {hiddenSolo.map((p) => renderProject(p))}
              {hiddenRoots.map((g) => section(g, 0))}
            </>
          ) : (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">Arraste um projeto ou uma categoria para cá para tirá-los da lista principal.</p>
          ))}
      </nav>
      <UpdateBanner />
      <div className="shrink-0 border-t px-2 pt-1.5">
        <UsageFooter />
      </div>
      <div className="flex h-9 shrink-0 items-center justify-between px-2">
        <button
          type="button"
          title="Tema"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setThemeMenu({ x: r.left, y: r.top - 8 - THEMES.length * 28 })
          }}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {(() => {
            const current = THEMES.find((t) => t.theme === props.theme) ?? THEMES[0]!
            return (
              <>
                <Icon name={current.icon} className="size-3.5" />
                {current.label}
              </>
            )
          })()}
        </button>
        <SizeControl
          zoom={props.zoom}
          terminalFontSize={props.terminalFontSize}
          fileFontSize={props.fileFontSize}
          onZoom={props.onZoom}
          onTerminalFont={props.onTerminalFont}
          onFileFont={props.onFileFont}
        />
      </div>
      {themeMenu && (
        <ContextMenu
          x={themeMenu.x}
          y={themeMenu.y}
          items={THEMES.map((t) => ({
            label: `${t.theme === props.theme ? '● ' : ''}${t.label}`,
            onSelect: () => props.onSetTheme(t.theme)
          }))}
          onClose={() => setThemeMenu(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={projectMenu(menu.project)} onClose={() => setMenu(null)} />}
      {groupMenu && (
        <ContextMenu x={groupMenu.x} y={groupMenu.y} items={groupMenuItems(groupMenu.group)} onClose={() => setGroupMenu(null)} />
      )}
    </aside>
  )
}

interface SideTabsProps {
  project: Project
  tabs: Tab[]
  selected: boolean
  activeTabId: string | undefined
  renameRequest: RenameRequest | null
  onSelect(tabId: string): void
  onClose(tabId: string): void
  onRename(tabId: string, title: string): void
  onContextMenu(tabId: string, x: number, y: number): void
  onReorder(fromId: string, toId: string, place: Place): void
}

// Componente próprio porque cada projeto tem o seu arrasto (o hook não pode ficar num laço).
function SideTabs(props: SideTabsProps): React.JSX.Element {
  const drag = useReorderDrag(`tabs-${props.project.id}`, 'y', props.onReorder)
  return (
    <>
      {props.tabs.map((tab) => {
        const active = props.selected && props.activeTabId === tab.id
        return (
          <div
            key={tab.id}
            {...drag.itemProps(tab.id)}
            onClick={() => props.onSelect(tab.id)}
            onAuxClick={(e) => e.button === 1 && props.onClose(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              props.onContextMenu(tab.id, e.clientX, e.clientY)
            }}
            className={cn(
              'group ml-5 flex h-7 cursor-default items-center gap-2 rounded-md pl-2 pr-1.5 text-xs',
              active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              hintClass(drag.hint, tab.id, 'y')
            )}
          >
            <TabIcon tab={tab} />
            <EditableTitle
              value={tab.title}
              editable={tab.kind === 'terminal'}
              className={cn('flex-1', isDormant(tab) && 'italic opacity-70')}
              onCommit={(title) => props.onRename(tab.id, title)}
              editRequest={props.renameRequest?.tabId === tab.id ? props.renameRequest.n : undefined}
            />
            <button
              type="button"
              title="Fechar aba"
              onClick={(e) => {
                e.stopPropagation()
                props.onClose(tab.id)
              }}
              className={cn(iconButton, 'hidden group-hover:block')}
            >
              <Icon name="fechar" className="size-3" />
            </button>
          </div>
        )
      })}
    </>
  )
}

interface GroupSectionProps {
  group: ProjectGroup
  groups: ProjectGroup[]
  projects: Project[]
  depth: number
  renderProject(project: Project, depth: number): React.JSX.Element
  renderSection(group: ProjectGroup, depth: number): React.JSX.Element
  creator(parentId: string | null, depth: number): React.ReactNode
  renameRequest: number | undefined
  onAction(action: GroupAction): void
  onArrangeProject(draggedId: string, drop: ProjectDrop): void
  onMenu(x: number, y: number): void
}

// Divisória de uma categoria, como "Ocultos": clique no nome recolhe; recebe projeto (entra nela) e categoria (vira subcategoria).
function GroupSection(props: GroupSectionProps): React.JSX.Element {
  const { group, depth } = props
  const projectZone = useReorderDrag('projects', 'y', () => {})
  // Categoria arrastada sobre outra: borda de cima põe antes, borda de baixo põe depois, o meio põe dentro.
  const [groupHint, setGroupHint] = useState<'before' | 'after' | 'inside' | null>(null)
  const groupMime = mimeFor('groups')
  const zoneFor = (e: React.DragEvent<HTMLElement>): 'before' | 'after' | 'inside' => {
    const rect = e.currentTarget.getBoundingClientRect()
    const y = (e.clientY - rect.top) / rect.height
    return y < 0.34 ? 'before' : y > 0.66 ? 'after' : 'inside'
  }
  const groupHandlers: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> = {
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(groupMime)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      const zone = zoneFor(e)
      setGroupHint((h) => (h === zone ? h : zone))
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setGroupHint(null)
    },
    onDrop: (e) => {
      if (!e.dataTransfer.types.includes(groupMime)) return
      e.preventDefault()
      e.stopPropagation()
      const zone = zoneFor(e)
      setGroupHint(null)
      const id = e.dataTransfer.getData(groupMime)
      if (!id || id === group.id) return
      if (zone === 'inside') props.onAction({ kind: 'nest', id, parentId: group.id })
      else props.onAction({ kind: 'place', id, targetId: group.id, place: zone })
    }
  }
  const inside = descendantIds(props.groups, group.id)
  const own = props.projects.filter((p) => !p.hidden && p.groupId === group.id)
  const total = props.projects.filter((p) => !p.hidden && p.groupId && (p.groupId === group.id || inside.has(p.groupId))).length
  const children = childrenOf(props.groups, group.id)
  const open = !group.collapsed
  const creating = props.creator(group.id, depth + 1)

  return (
    <div>
      <div
        role="button"
        data-group-row
        title={open ? `Recolher ${group.name}` : `Expandir ${group.name}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(mimeFor('groups'), group.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        {...mergeDragHandlers(
          projectZone.zoneProps((id) => props.onArrangeProject(id, { kind: 'section', section: { hidden: false, groupId: group.id } })),
          groupHandlers
        )}
        onClick={() => props.onAction({ kind: 'toggle', id: group.id })}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          props.onMenu(e.clientX, e.clientY)
        }}
        style={{ paddingLeft: 2 + depth * 12 }}
        className={cn(
          'group/cat mt-1.5 flex h-7 cursor-default items-center gap-1 rounded-md pr-1 text-xs text-muted-foreground hover:text-foreground',
          (projectZone.zoneActive || groupHint === 'inside') && 'bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--brand-amber)]',
          groupHint === 'before' && 'shadow-[inset_0_3px_0_var(--brand-amber)]',
          groupHint === 'after' && 'shadow-[inset_0_-3px_0_var(--brand-amber)]'
        )}
      >
        <span className="p-0.5">
          <Icon name="expandir" className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </span>
        <EditableTitle
          value={group.name}
          editable
          className="max-w-[60%] font-medium"
          editRequest={props.renameRequest}
          onCommit={(name) => name && props.onAction({ kind: 'rename', id: group.id, name })}
        />
        {groupHint ? (
          <span data-drop-hint className="whitespace-nowrap font-medium text-[var(--brand-amber)]">
            {{ before: 'Soltar antes', inside: 'Soltar dentro', after: 'Soltar depois' }[groupHint]}
          </span>
        ) : (
          <span className="tabular-nums">{total}</span>
        )}
        <div className="ml-1 h-px flex-1 bg-border" />
        <span
          title="Arraste para reordenar ou pôr dentro de outra categoria"
          className="cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover/cat:opacity-100"
        >
          <Icon name="arrastar" className="size-3.5" />
        </span>
      </div>
      {open && (
        <>
          {own.map((p) => props.renderProject(p, depth + 1))}
          {children.map((c) => props.renderSection(c, depth + 1))}
          {creating}
          {own.length === 0 && children.length === 0 && !creating && (
            <p style={{ paddingLeft: 8 + (depth + 1) * 12 }} className="py-0.5 text-[11px] text-muted-foreground">
              Arraste projetos para cá.
            </p>
          )}
        </>
      )}
    </div>
  )
}
