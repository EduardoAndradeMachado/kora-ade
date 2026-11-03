import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { copyText } from './CopyActions'
import type { MobileTab } from '@shared/mobile'

export function SessionActions({ tab, busy, renameOnly = false, onClose, onRename, onSuspend, onDelete, onUsage, onMetrics }: {
  tab: MobileTab
  busy: boolean
  renameOnly?: boolean
  onClose(): void
  onRename(title: string): Promise<void>
  onSuspend(): Promise<void>
  onDelete(): Promise<void>
  onUsage(): void
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
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="action-title"><div className="sheet-handle" /><header className="sheet-header"><div><span className="eyebrow">ABA</span><h1 id="action-title">{tab.title}</h1></div><button className="icon-button" aria-label="Fechar ações" onClick={onClose} disabled={busy}><Icon name="fechar" /></button></header>
    {renaming ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void onRename(title.trim()) }}><label htmlFor="tab-title">Nome da aba</label><input id="tab-title" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} autoFocus /><button className="primary" disabled={busy || !title.trim()}>Salvar nome</button></form> : <button className="action-row" disabled={busy} onClick={() => setRenaming(true)}><Icon name="editar" />Renomear<Icon name="expandir" /></button>}
    {!renameOnly && <>
      {tab.agent && <button className="action-row" onClick={() => void copyText(tab.agent!.sessionId).then(() => setNotice('ID copiado.'), (error: Error) => setNotice(error.message))}><Icon name="copiar" />Copiar ID da sessão</button>}
      <button className="action-row" onClick={onUsage}>Ver limites de uso</button>
      {tab.agent && <button className="action-row" onClick={onMetrics}><Icon name="metricas" />Métricas da sessão<Icon name="expandir" /></button>}
      {notice && <p role="status">{notice}</p>}
      <button className="action-row" disabled={busy} onClick={() => void onSuspend()}><Icon name={tab.live ? 'pausar' : 'retomar'} active />{tab.live ? 'Suspender sessão' : 'Continuar sessão'}<Icon name="expandir" /></button>
      {confirming ? <div className="close-confirm"><p>Fechar esta aba? A conversa salva continua no PC.</p><div><button onClick={() => setConfirming(false)} disabled={busy}>Cancelar</button><button className="danger-button" onClick={() => void onDelete()} disabled={busy}>Fechar aba</button></div></div> : <button className="action-row danger-button" disabled={busy} onClick={() => setConfirming(true)}><Icon name="fechar" />Fechar aba<Icon name="expandir" /></button>}
    </>}
  </section></div>
}
