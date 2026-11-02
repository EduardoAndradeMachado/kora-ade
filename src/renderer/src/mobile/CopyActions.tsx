import { useState } from 'react'
import { koraApp } from './api'

export interface CopyMenu { title: string; values: { label: string; text: string }[] }

export async function copyText(text: string): Promise<void> {
  const app = koraApp()
  if (app?.copiar) {
    const key = (window as unknown as { koraChaveAudio?: string }).koraChaveAudio
    if (!key) throw new Error('A tela ainda está abrindo. Tente de novo em instantes.')
    return app.copiar(text, key)
  }
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const field = document.createElement('textarea')
  field.value = text
  document.body.append(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  if (!copied) throw new Error('Não foi possível copiar. Tente novamente.')
}

export function CopyActions({ menu, onClose, onUsage }: { menu: CopyMenu; onClose(): void; onUsage?(): void }): React.JSX.Element {
  const [notice, setNotice] = useState('')
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="action-sheet" role="dialog" aria-modal="true" aria-label={menu.title}>
      <div className="sheet-handle" /><header className="sheet-header"><h1>{menu.title}</h1><button className="icon-button" aria-label="Fechar opções" onClick={onClose}>×</button></header>
      {menu.values.map(({ label, text }) => <button className="action-row" key={label} onClick={() => void copyText(text).then(() => setNotice('Copiado.'), (error: Error) => setNotice(error.message))}>{label}</button>)}
      {onUsage && <button className="action-row" onClick={onUsage}>Ver limites de uso</button>}
      {notice && <p role="status">{notice}</p>}
    </section>
  </div>
}
