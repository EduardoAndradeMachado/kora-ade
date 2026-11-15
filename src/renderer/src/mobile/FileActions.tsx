import { Fragment, useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { newEntryProblem, renameProblem, type Sibling } from '@shared/entry-name'
import type { EntryAction, EntryResult, MobileDirectory } from '@shared/mobile'
import { api, koraApp } from './api'
import { copyWithNotice } from './CopyActions'
import { showToast } from './toast'

// O que mudou no disco por esta folha: quem mostra o item (a lista, o arquivo aberto) acompanha.
export type EntryChange = { kind: 'moved'; from: string; to: string } | { kind: 'trashed'; path: string } | { kind: 'created'; path: string; isDir: boolean }
type View = 'main' | 'rename' | 'move' | 'remove' | 'file' | 'dir'

const nameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const parentOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(0, -1).join('/')
const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

export function entryRequest(body: EntryAction): Promise<EntryResult> {
  return api<EntryResult>('entry', body)
}

// Escolhe a pasta de destino dentro do projeto, uma pasta por vez, como a lista de arquivos.
function MoveTarget({ projectId, path, isDir, busy, onMove }: { projectId: string; path: string; isDir: boolean; busy: boolean; onMove(dir: string): void }): React.JSX.Element {
  const from = parentOf(path)
  const [dir, setDir] = useState(from)
  const [listing, setListing] = useState<MobileDirectory | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setListing(null)
    setError('')
    api<MobileDirectory>(`files?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(dir)}`)
      .then((next) => { if (current) setListing(next) }, (failure: Error) => { if (current) setError(failure.message) })
    return () => { current = false }
  }, [projectId, dir])
  const parts = dir ? dir.split(/[\\/]/).filter(Boolean) : []
  const folders = listing?.entries.filter((entry) => entry.isDir && !(isDir && samePath(entry.path, path))) ?? []
  return <div className="move-target">
    <nav className="files-path" aria-label="Pasta de destino">
      <button onClick={() => setDir('')} aria-current={parts.length === 0 ? 'location' : undefined}>Raiz</button>
      {parts.map((part, index) => <Fragment key={index}><span aria-hidden="true">/</span><button aria-current={index === parts.length - 1 ? 'location' : undefined} onClick={() => setDir(parts.slice(0, index + 1).join('/'))}>{part}</button></Fragment>)}
    </nav>
    {error && <p role="alert" className="sheet-notice">{error}</p>}
    <div className="move-folders" aria-busy={!listing && !error}>
      {listing && folders.length === 0 && <p className="empty-copy">Sem pastas aqui dentro.</p>}
      {folders.map((folder) => <button key={folder.path} className="folder-entry" onClick={() => setDir(folder.path)}><Icon name="projeto" /><span>{folder.name}</span><Icon name="expandir" /></button>)}
    </div>
    <button className="primary" disabled={busy || !listing || samePath(dir, from)} onClick={() => onMove(dir)}><Icon name="mover" active />{samePath(dir, from) ? 'Já está nesta pasta' : `Mover para ${parts.at(-1) ?? 'a raiz'}`}</button>
  </div>
}

// siblings: o que a lista já leu da pasta do item; contents, o que já leu de dentro da pasta (para criar nela). Servem
// para avisar o nome repetido enquanto digita; o PC confere tudo de novo ao gravar.
export function FileActions({ projectId, name, path, directory = false, busy, siblings = [], contents = [], initial = 'main', onAction, onClose, onChanged }: {
  projectId: string; name: string; path: string; directory?: boolean; busy: boolean
  siblings?: readonly Sibling[]
  contents?: readonly Sibling[]
  initial?: View
  onAction(action: 'baixar' | 'salvarComo' | 'compartilhar'): void
  onClose(): void
  onChanged(change: EntryChange): void
}): React.JSX.Element {
  const [view, setView] = useState<View>(initial)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [value, setValue] = useState('')
  const app = koraApp()
  const root = path === ''
  const disabled = busy || working
  const open = (next: View): void => {
    setView(next)
    setError('')
    setValue(next === 'rename' ? name : '')
  }
  const run = async (task: () => Promise<void>): Promise<void> => {
    setWorking(true)
    setError('')
    try { await task() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setWorking(false) }
  }
  const problem = view === 'rename' ? (value && renameProblem(value, name, siblings)) : view === 'file' || view === 'dir' ? (value.trim() && newEntryProblem(value, contents)) : null
  const create = (kind: 'file' | 'dir'): Promise<void> => run(async () => {
    const result = await entryRequest({ op: 'create', projectId, parent: path, name: value, kind })
    showToast(kind === 'file' ? `Arquivo criado: ${nameOf(result.path)}.` : `Pasta criada: ${nameOf(result.path)}.`)
    onChanged({ kind: 'created', path: result.path, isDir: kind === 'dir' })
  })
  const kind = directory ? 'a pasta' : 'o arquivo'
  const back = !root && view !== 'main' && view !== initial && <button className="icon-button" aria-label="Voltar às opções" disabled={disabled} onClick={() => open('main')}><Icon name="expandir" className="back-icon" /></button>
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !working) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-label={`Opções de ${name}`}>
    <div className="sheet-handle" /><header className="sheet-header">{back}<div className="sheet-title"><span className="eyebrow">{view === 'file' ? 'NOVO ARQUIVO' : view === 'dir' ? 'NOVA PASTA' : directory ? 'PASTA' : 'ARQUIVO'}</span><h1>{name}</h1></div><button className="icon-button" aria-label="Fechar opções" onClick={onClose} disabled={working}><Icon name="fechar" /></button></header>
    {view === 'main' && <>
      {directory && <>
        <button className="action-row" disabled={disabled} onClick={() => open('file')}><Icon name="novoArquivo" active />Novo arquivo aqui<Icon name="expandir" /></button>
        <button className="action-row" disabled={disabled} onClick={() => open('dir')}><Icon name="novoProjeto" active />Nova pasta aqui<Icon name="expandir" /></button>
      </>}
      <button className="action-row" onClick={() => void copyWithNotice(path, 'Caminho copiado.').then(onClose, (failure: Error) => setError(failure.message))}><Icon name="copiar" active />Copiar caminho</button>
      {!directory && !name.startsWith('.') && <>
        {app?.compartilhar && <button className="action-row" disabled={disabled} onClick={() => onAction('compartilhar')}><Icon name="publicar" active />Compartilhar arquivo</button>}
        {app?.salvarComo && <button className="action-row" disabled={disabled} onClick={() => onAction('salvarComo')}><Icon name="baixar" active />Salvar como…</button>}
        {(!app || app.baixar) && <button className="action-row" disabled={disabled} onClick={() => onAction('baixar')}><Icon name="baixar" active />{app?.salvarComo ? 'Salvar em Downloads/Kora' : 'Baixar para o celular'}</button>}
      </>}
      <button className="action-row" disabled={disabled} onClick={() => open('rename')}><Icon name="editar" active />Renomear<Icon name="expandir" /></button>
      <button className="action-row" disabled={disabled} onClick={() => open('move')}><Icon name="mover" active />Mover para…<Icon name="expandir" /></button>
      <button className="action-row" disabled={disabled} onClick={() => void run(async () => {
        const result = await entryRequest({ op: 'duplicate', projectId, path })
        showToast(`Cópia criada: ${nameOf(result.path)}.`)
        onChanged({ kind: 'created', path: result.path, isDir: directory })
      })}><Icon name="copiar" active />Duplicar</button>
      <button className="action-row danger-button" disabled={disabled} onClick={() => open('remove')}><Icon name="excluir" />Excluir<Icon name="expandir" /></button>
    </>}
    {view === 'rename' && <form className="rename-form" onSubmit={(event) => { event.preventDefault(); if (!problem) void run(async () => {
      const result = await entryRequest({ op: 'rename', projectId, path, name: value })
      onChanged({ kind: 'moved', from: path, to: result.path })
    }) }}><label htmlFor="entry-name">Novo nome</label><input id="entry-name" value={value} maxLength={255} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={Boolean(problem)} onChange={(event) => setValue(event.target.value)} onFocus={(event) => {
      // Como no PC: o nome vem selecionado até antes da extensão.
      const dot = directory ? -1 : name.lastIndexOf('.')
      event.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length)
    }} />{problem ? <small role="alert" className="field-problem">{problem}</small> : <small>Muda o nome no disco do PC.</small>}<button className="primary" disabled={disabled || !value.trim() || Boolean(problem) || value.trim() === name}>Renomear</button></form>}
    {(view === 'file' || view === 'dir') && <form className="rename-form" onSubmit={(event) => { event.preventDefault(); if (!problem && value.trim()) void create(view) }}><label htmlFor="entry-new">{view === 'file' ? 'Nome do arquivo' : 'Nome da pasta'}</label><input id="entry-new" value={value} maxLength={4096} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={view === 'file' ? 'nome.ts ou pasta/nome.ts' : 'nome ou pasta/subpasta'} aria-invalid={Boolean(problem)} onChange={(event) => setValue(event.target.value)} />{problem ? <small role="alert" className="field-problem">{problem}</small> : <small>Com barras, as pastas que faltam são criadas junto.</small>}<button className="primary" disabled={disabled || !value.trim() || Boolean(problem)}>{view === 'file' ? 'Criar arquivo' : 'Criar pasta'}</button></form>}
    {view === 'move' && <MoveTarget projectId={projectId} path={path} isDir={directory} busy={disabled} onMove={(dir) => void run(async () => {
      const result = await entryRequest({ op: 'move', projectId, path, to: dir })
      showToast(`Movido para ${dir ? nameOf(dir) : 'a raiz'}.`)
      onChanged({ kind: 'moved', from: path, to: result.path })
    })} />}
    {view === 'remove' && <div className="close-confirm"><p>Excluir {kind} “{name}”? {directory ? 'A pasta e tudo o que está dentro dela vão para a Lixeira do Windows. Dá para restaurar por lá.' : 'O arquivo vai para a Lixeira do Windows. Dá para restaurar por lá.'}</p><div><button onClick={() => open('main')} disabled={disabled}>Cancelar</button><button className="danger-button" disabled={disabled} onClick={() => void run(async () => {
      await entryRequest({ op: 'trash', projectId, path })
      showToast(`“${name}” foi para a Lixeira do PC.`)
      onChanged({ kind: 'trashed', path })
    })}>Mover para a Lixeira</button></div></div>}
    {error && <p role="alert" className="sheet-notice">{error}</p>}
  </section></div>
}
