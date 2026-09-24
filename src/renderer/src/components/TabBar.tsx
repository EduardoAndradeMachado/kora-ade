import type { Viewer } from '@shared/file-kind'
import type { AgentActivity, AgentSession } from '@shared/agent'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { NewTabMenu, type NewTabChoice } from '@/components/NewTabMenu'
import { EditableTitle } from '@/components/EditableTitle'
import { cn } from '@/lib/utils'
import { hintClass, useReorderDrag } from '@/lib/drag'
import type { Place } from '@shared/arrange'
import { Icon, type IconName } from '@/brand/icons'
import { SymbolCropped } from '@/brand/Logo'

export type Tab =
  | {
      kind: 'terminal'
      id: string
      title: string
      titleLocked: boolean
      live: boolean
      agent: AgentSession | null
      activity?: AgentActivity | null
      // Parou de trabalhar e você ainda não abriu a aba: símbolo do Kora no lugar do ícone e sininho no título.
      alert?: boolean
    }
  | {
      kind: 'file'
      id: string
      title: string
      path: string
      viewer: Exclude<Viewer, 'external'>
      editing: boolean
      dirty: boolean
      // Pedido de ir até uma linha (ex.: Ctrl+clique em "src/a.ts:42" no terminal); n muda a cada pedido.
      jump?: { line: number; n: number }
    }

export type TabPlace = 'bar' | 'side'
export interface RenameRequest {
  tabId: string
  where: TabPlace
  n: number
}

export const isDormant = (tab: Tab): boolean => tab.kind === 'terminal' && !tab.live

export function TabIcon({ tab, className }: { tab: Tab; className?: string }): React.JSX.Element {
  const dim = isDormant(tab) && 'opacity-50'
  if (tab.kind === 'file') {
    const name: IconName = { markdown: 'arquivo', code: 'codigo', pdf: 'pdf', image: 'imagem' }[tab.viewer] as IconName
    return <Icon name={name} active={false} className={cn('size-3.5', className)} />
  }
  if (tab.agent) {
    const icon = <AgentIcon kind={tab.agent.kind} className={cn('size-3.5', dim, className)} />
    const activity = tab.live ? tab.activity : null
    if (tab.live && tab.alert) {
      return (
        <span
          data-activity="waiting"
          data-alert
          title={`${agentLabel(tab.agent.kind)} parou e está esperando você`}
          className="relative inline-flex size-3.5 shrink-0 items-center justify-center overflow-visible"
        >
          <SymbolCropped height={18} className="kora-balanca" />
        </span>
      )
    }
    if (!activity) return icon
    return (
      <span
        data-activity={activity}
        title={`${agentLabel(tab.agent.kind)} ${activity === 'working' ? 'trabalhando' : 'esperando você'}`}
        className="relative inline-flex shrink-0"
      >
        {icon}
        {activity === 'working' ? <WorkingRing /> : <WaitingDot />}
      </span>
    )
  }
  return <Icon name="terminal" active={!isDormant(tab)} className={cn('size-3.5', dim, className)} />
}

// Trabalhando: o braço âmbar do símbolo dando voltas em torno do ícone, como no carregamento da identidade.
function WorkingRing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="kora-spin pointer-events-none absolute -inset-[3px] size-[calc(100%+6px)]">
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="var(--brand-amber)" strokeWidth="2" strokeLinecap="round" strokeDasharray="16 50" />
    </svg>
  )
}

// Esperando você: ponto âmbar no canto, com contorno na cor do fundo para se destacar sobre o ícone.
function WaitingDot(): React.JSX.Element {
  return (
    <span className="pointer-events-none absolute -right-[3px] -top-[3px] size-[7px] rounded-full bg-[var(--brand-amber)] ring-[1.5px] ring-background" />
  )
}

export function AlertBell({ tab }: { tab: Tab }): React.JSX.Element | null {
  if (tab.kind !== 'terminal' || !tab.live || !tab.alert) return null
  return <Icon name="sino" className="size-3.5 shrink-0 text-[var(--brand-amber)]" />
}

interface Props {
  tabs: Tab[]
  activeId: string | undefined
  rightPanelOpen: boolean
  onSelect(id: string): void
  onClose(id: string): void
  onRename(id: string, title: string): void
  onContextMenu(id: string, x: number, y: number): void
  renameRequest: RenameRequest | null
  onNew(choice: NewTabChoice): void
  onToggleRightPanel(): void
  // Sem o painel direito, é a barra de abas que fica embaixo dos botões de janela.
  atWindowEdge: boolean
  projectId: string
  onReorder(fromId: string, toId: string, place: Place): void
}

export function TabBar(props: Props): React.JSX.Element {
  // Mesmo escopo das abas desse projeto na lateral: dá para arrastar de uma lista para a outra.
  const drag = useReorderDrag(`tabs-${props.projectId}`, 'x', props.onReorder)
  return (
    <div
      className={cn(
        'window-drag flex h-10 shrink-0 items-center gap-1 border-b bg-background pl-2',
        props.atWindowEdge ? 'pr-[calc(var(--window-controls-width)+0.25rem)]' : 'pr-1'
      )}
    >
      <div
        className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        onWheel={(e) => {
          if (!e.ctrlKey && e.deltaY) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {props.tabs.map((tab) => (
          <div
            key={tab.id}
            data-no-drag
            {...drag.itemProps(tab.id)}
            onClick={() => props.onSelect(tab.id)}
            onAuxClick={(e) => e.button === 1 && props.onClose(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              props.onContextMenu(tab.id, e.clientX, e.clientY)
            }}
            className={cn(
              'group flex h-7 max-w-56 shrink-0 cursor-default items-center gap-1.5 rounded-md pl-2 pr-1 text-xs',
              tab.id === props.activeId
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              hintClass(drag.hint, tab.id, 'x')
            )}
          >
            <TabIcon tab={tab} />
            <EditableTitle
              value={tab.title}
              editable={tab.kind === 'terminal'}
              className={cn(isDormant(tab) && 'italic opacity-70')}
              onCommit={(title) => props.onRename(tab.id, title)}
              editRequest={props.renameRequest?.tabId === tab.id ? props.renameRequest.n : undefined}
            />
            <AlertBell tab={tab} />
            <button
              type="button"
              title="Fechar aba"
              onClick={(e) => {
                e.stopPropagation()
                props.onClose(tab.id)
              }}
              className={cn(
                'rounded p-0.5 hover:bg-accent',
                tab.kind === 'file' && tab.dirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              {tab.kind === 'file' && tab.dirty ? (
                <span className="block size-3 text-center leading-3 group-hover:hidden">●</span>
              ) : null}
              <Icon name="fechar" className={cn('size-3', tab.kind === 'file' && tab.dirty && 'hidden group-hover:block')} />
            </button>
          </div>
        ))}
        <NewTabMenu
          onChoose={props.onNew}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        />
      </div>
      <button
        type="button"
        title={props.rightPanelOpen ? 'Esconder painel lateral' : 'Mostrar painel lateral'}
        onClick={props.onToggleRightPanel}
        className={cn(
          'shrink-0 rounded-md p-1.5 hover:bg-secondary hover:text-foreground',
          props.rightPanelOpen ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        <Icon name="painel" active={props.rightPanelOpen} />
      </button>
    </div>
  )
}
