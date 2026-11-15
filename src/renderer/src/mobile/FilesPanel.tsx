import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileDirectory, MobileGit } from '@shared/mobile'
import { viewerFor } from '@shared/file-kind'
import { Icon, type IconName } from '@/brand/icons'
import { GIT_STYLE, gitMaps, gitPathKey } from '@/lib/git-decorations'
import { api } from './api'
import { SkeletonRows } from './Skeleton'
import { useLongPress } from './longPress'
import { FileActions, type EntryChange } from './FileActions'
import { onFilesChanged, touchesDir } from './file-events'
import { download, onDownloaded } from './downloads'

const FILE_ICON: Record<ReturnType<typeof viewerFor>, IconName> = { markdown: 'arquivo', code: 'codigo', pdf: 'pdf', image: 'imagem', media: 'arquivo', notebook: 'codigo', sheet: 'codigo', external: 'arquivo' }

// Uma pasta por vez, com as cores do git do explorador do PC; tocar na pasta entra nela, no arquivo abre.
// connection: muda a cada vez que a ligação com o PC volta; o aviso de mudança perdido no meio vira uma releitura.
export function FilesPanel({ projectId, dir, connection, onFailed, onDir, onFile, selected, onSelect, onChanged }: {
  projectId: string
  dir: string
  connection: number
  onFailed(): void
  onDir(dir: string): void
  onFile(path: string): void
  selected: { path: string; name: string; isDir: boolean } | null
  onSelect(entry: { path: string; name: string; isDir: boolean } | null): void
  // Item renomeado, movido ou apagado por aqui: o rascunho e a pasta lembrada acompanham.
  onChanged(change: EntryChange): void
}): React.JSX.Element {
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null)
  const [listing, setListing] = useState<MobileDirectory | null>(null)
  const [gitFiles, setGitFiles] = useState<MobileGit['files']>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [notice, setNotice] = useState('')
  const longPress = useLongPress()
  useEffect(() => onDownloaded((event) => {
    if (event.tipo === 'progresso') return
    setTransferring(false)
    if (event.tipo === 'erro') setError(event.mensagem)
    if (event.tipo === 'salvo') setNotice(event.destino === 'escolhido' ? `Salvo no local escolhido: ${event.nome}.` : `Salvo em Downloads/Kora: ${event.nome}.`)
  }), [])
  const transfer = async (action: 'baixar' | 'salvarComo' | 'compartilhar'): Promise<void> => {
    if (!selected) return
    onSelect(null)
    setTransferring(true)
    setError(null)
    setNotice('')
    try {
      if (await download(`project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(selected.path)}`, selected.name, action) === 'browser') setTransferring(false)
    } catch (error) {
      setTransferring(false)
      setError(error instanceof Error ? error.message : String(error))
    }
  }
  // Toques rápidos em pastas: só a resposta do último pedido vale, uma atrasada não troca a tela.
  const request = useRef(0)
  // Outra pasta: a lista da anterior sai na hora, para não parecer o conteúdo da nova enquanto ela carrega ou falha.
  useEffect(() => setListing((current) => (current?.path === dir ? current : null)), [dir])
  const load = useCallback(() => {
    const mine = ++request.current
    setLoading(true)
    setError(null)
    api<MobileDirectory>(`files?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(dir)}`)
      .then((next) => { if (mine === request.current) setListing(next) }, (failure: Error) => {
        if (mine !== request.current) return
        setListing(null)
        setError(failure.message)
        onFailed()
      })
      .finally(() => { if (mine === request.current) setLoading(false) })
  }, [projectId, dir])
  // Uma vez por projeto (e no atualizar): vale para todas as pastas, e as cores chegam depois da lista sem segurá-la.
  const loadGit = useCallback(() => {
    void api<MobileGit>(`git?project=${encodeURIComponent(projectId)}`).then((status) => setGitFiles(status.files), () => {})
  }, [projectId])
  useEffect(load, [load])
  useEffect(loadGit, [loadGit])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    load()
    loadGit()
  }, [connection])
  // O status do git muda a cada arquivo salvo: com o agente gravando sem parar, a releitura espera a rajada passar.
  useEffect(() => {
    let gitTimer: ReturnType<typeof setTimeout> | undefined
    const stop = onFilesChanged((event) => {
      if (touchesDir(event, projectId, dir)) load()
      if (event.projectId === projectId && (event.git || event.rescan)) {
        clearTimeout(gitTimer)
        gitTimer = setTimeout(loadGit, 800)
      }
    })
    return () => { stop(); clearTimeout(gitTimer) }
  }, [projectId, dir, load, loadGit])
  const changed = (change: EntryChange, fromSheet: boolean): void => {
    if (fromSheet) onSelect(null)
    else setCreating(null)
    onChanged(change)
    load()
    loadGit()
    if (!fromSheet && change.kind === 'created' && !change.isDir) onFile(change.path)
  }
  const siblings = listing?.entries.map((entry) => ({ name: entry.name, isDir: entry.isDir })) ?? []
  const git = useMemo(() => gitMaps(gitFiles), [gitFiles])
  const parts = dir ? dir.split(/[\\/]/) : []
  return <div className={`files-panel ${loading && listing ? 'refreshing' : ''}`}>
    <nav className="files-path" aria-label="Pasta atual">
      <button onClick={() => onDir('')}>Raiz</button>
      {parts.map((part, index) => <Fragment key={index}><span aria-hidden="true">/</span><button onClick={() => onDir(parts.slice(0, index + 1).join('/'))}>{part}</button></Fragment>)}
      <button className="icon-button files-new" aria-label="Novo arquivo" disabled={!listing} onClick={() => setCreating('file')}><Icon name="novoArquivo" /></button>
      <button className="icon-button" aria-label="Nova pasta" disabled={!listing} onClick={() => setCreating('dir')}><Icon name="novoProjeto" /></button>
      <button className="icon-button" aria-label="Atualizar arquivos" disabled={loading} onClick={() => { load(); loadGit() }}><Icon name="atualizar" /></button>
    </nav>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {selected && <FileActions projectId={projectId} name={selected.name} path={selected.path} directory={selected.isDir} busy={transferring} siblings={siblings} onClose={() => onSelect(null)} onAction={(action) => void transfer(action)} onChanged={(change) => changed(change, true)} />}
    {creating && <FileActions projectId={projectId} name={parts.at(-1) ?? 'Raiz do projeto'} path={dir} directory busy={false} contents={siblings} initial={creating} onClose={() => setCreating(null)} onAction={() => {}} onChanged={(change) => changed(change, false)} />}
    {!listing && !error && <SkeletonRows label="Abrindo a pasta…" row="file-row" count={9} />}
    {listing?.entries.length === 0 && <p className="empty-copy">Pasta vazia.</p>}
    {listing?.entries.map((entry) => {
      const status = (entry.isDir ? git.dirs : git.files).get(gitPathKey(entry.path))
      const style = status ? GIT_STYLE[status] : null
      return <button key={entry.path} className="file-row" {...longPress(() => onSelect(entry))} onClick={() => (entry.isDir ? onDir(entry.path) : onFile(entry.path))}>
        <Icon name={entry.isDir ? 'projeto' : FILE_ICON[viewerFor(entry.name)]} />
        <span className={`file-name ${style?.className ?? ''}`}>{entry.name}</span>
        {style && !entry.isDir && <small className={style.className}>{style.letter}</small>}
        {entry.isDir && <Icon name="expandir" />}
      </button>
    })}
  </div>
}
