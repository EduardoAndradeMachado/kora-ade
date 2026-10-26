import { useEffect } from 'react'
import { Icon } from '@/brand/icons'
import { AgentIcon } from '@/components/AgentIcon'
import { OPTIONS } from '@/components/NewTabMenu'
import type { MobileTab } from '@shared/mobile'

export type NewTabKind = 'claude' | 'codex' | 'opencode' | 'shell'

// Fixar uma sessão pelo ID fica só no PC: no celular as conversas salvas já aparecem na tela do projeto.
const CHOICES = OPTIONS.filter((option): option is typeof option & { choice: NewTabKind } => option.choice !== 'existing')

// alert: a sessão parou enquanto você não olhava; o sininho fica no lugar do modelo até a conversa ser aberta.
export function TabIcon({ tab, alert = false }: { tab: MobileTab; alert?: boolean }): React.JSX.Element {
  if (alert && tab.live) return <Icon name="sino" active className="tab-alert" />
  return tab.agent ? <AgentIcon kind={tab.agent.kind} className={tab.live ? '' : 'opacity-50'} /> : <Icon name="terminal" active={tab.live} />
}

export function NewTabSheet({ projectName, busy, onClose, onChoose }: {
  projectName: string
  busy: boolean
  onClose(): void
  onChoose(kind: NewTabKind): void
}): React.JSX.Element {
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="new-tab-title"><div className="sheet-handle" /><header className="sheet-header"><div><span className="eyebrow">NOVA ABA</span><h1 id="new-tab-title">{projectName}</h1></div><button className="icon-button" aria-label="Fechar" onClick={onClose} disabled={busy}><Icon name="fechar" /></button></header>
    {CHOICES.map((option) => <button key={option.choice} className="action-row new-tab-option" disabled={busy} onClick={() => onChoose(option.choice)}>
      {option.choice === 'shell' ? <Icon name="terminal" /> : <AgentIcon kind={option.choice} />}
      <span><strong>{option.label}</strong><small>{option.hint}</small></span>
    </button>)}
  </section></div>
}
