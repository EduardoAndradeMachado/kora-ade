import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { agentLabel } from '@/components/AgentIcon'
import { copyText } from './CopyActions'
import type { MobileTab } from '@shared/mobile'

export function SessionActions({ tab, busy, renameOnly = false, onClose, onRename, onSuspend, onDelete, onMetrics }: {
  tab: MobileTab
  busy: boolean
  renameOnly?: boolean
  onClose(): void
  onRename(title: string): Promise<void>
  onSuspend(): Promise<void>
  onDelete(): Promise<void>
  onMetrics(): void
}): React.JSX.Element {
  const [notice, setNotice] = useState('')
  const [title, setTitle] = useState(tab.title)
  const [renaming, setRenaming] = useState(renameOnly)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const agent = tab.agent
  const copyId = (sessionId: string): void => void copyText(sessionId).then(() => setNotice('ID copiado.'), (error: Error) => setNotice(error.message))
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="action-title"><div className="sheet-handle" /><header className="sheet-header"><div><span className="eyebrow">{agent ? `ABA · ${agentLabel(agent.kind).toLocaleUpperCase('pt-BR')}` : 'TERMINAL'}</span><h1 id="action-title">{tab.title}</h1></div><button className="icon-button" aria-label="Fechar ações" onClick={onClose} disabled={busy}><Icon name="fechar" /></button></header>
    {!renameOnly && agent && <div className="session-id">
      <button className="session-id-card" aria-label="Copiar ID da sessão" onClick={() => copyId(agent.sessionId)}><span><small>ID da sessão · {agentLabel(agent.kind)}</small><code>{agent.sessionId}</code></span><Icon name="copiar" active /></button>
      {notice && <p role="status">{notice}</p>}
    </div>}
    {renaming ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void onRename(title.trim()) }}><label htmlFor="tab-title">Nome da aba</label><input id="tab-title" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} autoFocus /><button className="primary" disabled={busy || !title.trim()}>Salvar nome</button></form> : <button className="action-row" disabled={busy} onClick={() => setRenaming(true)}><Icon name="editar" active />Renomear<Icon name="expandir" /></button>}
    {!renameOnly && <>
      {agent && <button className="action-row" onClick={onMetrics}><Icon name="metricas" active />Métricas da sessão<Icon name="expandir" /></button>}
      <button className="action-row" disabled={busy} onClick={() => void onSuspend()}><Icon name={tab.live ? 'pausar' : 'retomar'} active />{tab.live ? 'Suspender sessão' : 'Continuar sessão'}<Icon name="expandir" /></button>
      {confirming ? <div className="close-confirm"><p>Fechar esta aba? A conversa salva continua no PC.</p><div><button onClick={() => setConfirming(false)} disabled={busy}>Cancelar</button><button className="danger-button" onClick={() => void onDelete()} disabled={busy}>Fechar aba</button></div></div> : <button className="action-row danger-button" disabled={busy} onClick={() => setConfirming(true)}><Icon name="fechar" />Fechar aba<Icon name="expandir" /></button>}
    </>}
  </section></div>
}
