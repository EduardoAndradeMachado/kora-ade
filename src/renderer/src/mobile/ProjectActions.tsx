import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { copyText } from './CopyActions'
import { PROJECT_NAME_MAX, type Project } from '@shared/state'

export function ProjectActions({ project, busy, onClose, onRename }: {
  project: Project
  busy: boolean
  onClose(): void
  onRename(name: string): Promise<void>
}): React.JSX.Element {
  const [notice, setNotice] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.name)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="project-action-title"><div className="sheet-handle" /><header className="sheet-header"><div><span className="eyebrow">PROJETO</span><h1 id="project-action-title">{project.name}</h1></div><button className="icon-button" aria-label="Fechar opções" onClick={onClose} disabled={busy}><Icon name="fechar" /></button></header>
    <button className="action-row" onClick={() => void copyText(project.path).then(() => setNotice('Caminho copiado.'), (error: Error) => setNotice(error.message))}><Icon name="copiar" active />Copiar caminho</button>
    {renaming
      ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void onRename(name.trim()) }}><label htmlFor="project-name">Nome do projeto</label><input id="project-name" value={name} maxLength={PROJECT_NAME_MAX} onChange={(event) => setName(event.target.value)} autoFocus /><small>Muda só o nome no Kora; a pasta no PC continua igual. Vazio volta ao nome da pasta.</small><button className="primary" disabled={busy}>Salvar nome</button></form>
      : <button className="action-row" disabled={busy} onClick={() => setRenaming(true)}><Icon name="editar" active />Renomear<Icon name="expandir" /></button>}
    {notice && <p role="status">{notice}</p>}
  </section></div>
}
