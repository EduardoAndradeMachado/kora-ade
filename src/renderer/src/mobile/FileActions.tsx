import { useState } from 'react'
import { koraApp } from './api'
import { copyText } from './CopyActions'

export function FileActions({ name, path, directory = false, busy, onAction, onClose }: {
  name: string; path: string; directory?: boolean; busy: boolean
  onAction(action: 'baixar' | 'salvarComo' | 'compartilhar'): void
  onClose(): void
}): React.JSX.Element {
  const [notice, setNotice] = useState('')
  const app = koraApp()
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-label={`Opções de ${name}`}>
    <div className="sheet-handle" /><header className="sheet-header"><h1>{name}</h1><button className="icon-button" aria-label="Fechar opções" onClick={onClose}>×</button></header>
    <button className="action-row" onClick={() => void copyText(path).then(() => setNotice('Caminho copiado.'), (error: Error) => setNotice(error.message))}>Copiar caminho</button>
    {!directory && !name.startsWith('.') && <>
      {app?.compartilhar && <button className="action-row" disabled={busy} onClick={() => onAction('compartilhar')}>Compartilhar arquivo</button>}
      {app?.salvarComo && <button className="action-row" disabled={busy} onClick={() => onAction('salvarComo')}>Salvar como…</button>}
      {(!app || app.baixar) && <button className="action-row" disabled={busy} onClick={() => onAction('baixar')}>{app?.salvarComo ? 'Salvar em Downloads/Kora' : 'Baixar para o celular'}</button>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </section></div>
}
