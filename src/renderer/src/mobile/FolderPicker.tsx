import { Fragment, useEffect, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import type { MobileFolders } from '@shared/mobile'
import { api } from './api'

// C:\Users\Eduardo → C:\ · C:\Users · C:\Users\Eduardo; também / (Linux, macOS) e \\servidor\pasta (rede).
function crumbs(path: string): { name: string; path: string }[] {
  const sep = path.includes('\\') ? '\\' : '/'
  const root = path.startsWith('\\\\') ? '\\\\' : path.startsWith('/') ? '/' : ''
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.map((name, index) => ({
    name,
    path: root + parts.slice(0, index + 1).join(sep) + (index === 0 && /^[A-Za-z]:$/.test(name) ? sep : '')
  }))
}

export function FolderPicker({ projectName, busy, onClose, onSelect }: {
  projectName?: string
  busy: boolean
  onClose(): void
  onSelect(path: string): Promise<void>
}): React.JSX.Element {
  const [listing, setListing] = useState<MobileFolders | null>(null)
  const [path, setPath] = useState('')
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [creating, setCreating] = useState(false)
  const [folderName, setFolderName] = useState('')
  const version = useRef(0)
  const trail = useRef<HTMLElement>(null)
  // Caminho fundo não cabe: a trilha abre rolada até a pasta atual.
  useEffect(() => { trail.current?.scrollTo({ left: trail.current.scrollWidth }) }, [listing])
  const show = async (fetch: () => Promise<MobileFolders>): Promise<void> => {
    const request = ++version.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetch()
      if (request !== version.current) return
      setListing(next)
      setPath(next.path)
      setFilter('')
      setTyping(false)
      setCreating(false)
      setFolderName('')
    } catch (error) { if (request === version.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (request === version.current) setLoading(false) }
  }
  const load = (path?: string): Promise<void> => show(() => api<MobileFolders>(`folders${path ? `?path=${encodeURIComponent(path)}` : ''}`))
  // A pasta nasce vazia dentro da atual e já fica escolhida: falta só tocar em Adicionar projeto.
  const createFolder = (): Promise<void> => show(() => api<MobileFolders>('folders', { parent: listing!.path, name: folderName }))
  useEffect(() => { void load(); return () => { version.current++ } }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const folders = listing?.folders.filter((folder) => folder.name.toLocaleLowerCase('pt-BR').includes(filter.toLocaleLowerCase('pt-BR'))) ?? []
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="folder-sheet" role="dialog" aria-modal="true" aria-labelledby="folder-title">
      <div className="sheet-handle" />
      <header className="sheet-header"><div><span className="eyebrow">PASTAS DO PC</span><h1 id="folder-title">{projectName ? 'Revincular projeto' : 'Novo projeto'}</h1></div><button className="icon-button" aria-label="Fechar seletor de pastas" onClick={onClose} disabled={busy}><Icon name="fechar" /></button></header>
      <p className="sheet-description">{projectName ? `Escolha a pasta de “${projectName}”. O projeto e suas abas serão mantidos.` : 'Escolha uma pasta no computador para adicionar ao Kora.'}</p>
      <div className="folder-shortcuts">{listing?.shortcuts.map((shortcut) => <button key={shortcut.path} disabled={loading || busy} onClick={() => void load(shortcut.path)}><Icon name="projeto" />{shortcut.name}</button>)}</div>
      {/* No celular quase ninguém digita caminho: a trilha navega por toque, e o campo só aparece quando pedido. */}
      <div className="folder-trail">
        <nav aria-label="Pasta atual" ref={trail}>{listing && crumbs(listing.path).map((crumb, index, all) => <Fragment key={crumb.path}>
          {index > 0 && <span aria-hidden="true">›</span>}
          <button aria-current={index === all.length - 1 ? 'location' : undefined} disabled={loading || busy} onClick={() => void load(crumb.path)}>{crumb.name}</button>
        </Fragment>)}</nav>
        <button className="icon-button" aria-label="Digitar caminho" aria-pressed={typing} onClick={() => { setTyping((open) => !open); setCreating(false) }}><Icon name="editar" /></button>
      </div>
      {typing && <form className="path-form" onSubmit={(event) => { event.preventDefault(); void load(path.trim()) }}><label htmlFor="pc-folder-path">Caminho no PC</label><div><input id="pc-folder-path" autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\Users\…\projeto" autoComplete="off" autoCapitalize="off" spellCheck={false} /><button aria-label="Abrir caminho" disabled={loading || busy || !path.trim()}><Icon name="expandir" /></button></div></form>}
      {creating && <form className="path-form" onSubmit={(event) => { event.preventDefault(); void createFolder() }}><label htmlFor="pc-folder-name">Nova pasta em “{listing && (crumbs(listing.path).at(-1)?.name ?? listing.path)}”</label><div><input id="pc-folder-name" autoFocus value={folderName} maxLength={255} onChange={(event) => setFolderName(event.target.value)} placeholder="Nome da pasta" autoComplete="off" spellCheck={false} /><button aria-label="Criar pasta" disabled={loading || busy || !folderName.trim()}><Icon name="ok" /></button></div></form>}
      <div className="folder-toolbar"><button disabled={!listing?.parent || loading || busy} onClick={() => void load(listing?.parent ?? undefined)}><Icon name="setaCima" />Pasta acima</button><button aria-pressed={creating} disabled={!listing || loading || busy} onClick={() => { setCreating((open) => !open); setTyping(false) }}><Icon name="novoProjeto" />Nova pasta</button><label className="folder-filter"><Icon name="buscar" /><input aria-label="Filtrar pastas" placeholder="Filtrar" value={filter} onChange={(event) => setFilter(event.target.value)} /></label></div>
      {error && <p className="folder-error" role="alert"><Icon name="alerta" />{error}</p>}
      <div className="folder-entries" aria-busy={loading}>
        {loading ? <p className="empty-copy">Carregando pastas…</p> : folders.map((folder) => <button className="folder-entry" key={folder.path} onClick={() => void load(folder.path)} disabled={busy}><Icon name="projeto" /><span>{folder.name}</span><Icon name="expandir" /></button>)}
        {!loading && !error && folders.length === 0 && <p className="empty-copy">{filter ? 'Nenhuma pasta com esse nome.' : 'Esta pasta não contém outras pastas. Você pode selecioná-la abaixo.'}</p>}
      </div>
      <footer className="folder-footer"><span className="folder-selected">{listing ? crumbs(listing.path).at(-1)?.name ?? listing.path : 'Escolha uma pasta'}</span><button className="primary" disabled={!listing || loading || busy} onClick={() => {
        setError(null)
        void onSelect(listing!.path).catch((error) => setError(error instanceof Error ? error.message : String(error)))
      }}><Icon name={projectName ? 'mover' : 'novoProjeto'} active />{busy ? 'Salvando…' : projectName ? 'Revincular pasta' : 'Adicionar projeto'}</button></footer>
    </section>
  </div>
}
