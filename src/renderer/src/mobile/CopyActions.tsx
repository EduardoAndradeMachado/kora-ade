import { useState } from 'react'
import { Icon } from '@/brand/icons'
import { koraApp } from './api'
import { showToast } from './toast'

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

// O app Android já mostra o aviso do sistema ao copiar: o da página fica só para o navegador, senão saem dois.
export async function copyWithNotice(text: string, notice: string): Promise<void> {
  await copyText(text)
  if (!koraApp()?.copiar) showToast(notice)
}

export function CopyActions({ menu, onClose }: { menu: CopyMenu; onClose(): void }): React.JSX.Element {
  const [notice, setNotice] = useState('')
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="action-sheet" role="dialog" aria-modal="true" aria-label={menu.title}>
      <div className="sheet-handle" /><header className="sheet-header"><h1>{menu.title}</h1><button className="icon-button" aria-label="Fechar opções" onClick={onClose}><Icon name="fechar" /></button></header>
      {menu.values.map(({ label, text }) => <button className="action-row" key={label} onClick={() => void copyWithNotice(text, 'Copiado.').then(onClose, (error: Error) => setNotice(error.message))}><Icon name="copiar" active />{label}</button>)}
      {notice && <p role="alert" className="sheet-notice">{notice}</p>}
    </section>
  </div>
}
