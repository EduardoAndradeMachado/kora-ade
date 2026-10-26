import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileDirectory, MobileGit } from '@shared/mobile'
import { viewerFor } from '@shared/file-kind'
import { Icon, type IconName } from '@/brand/icons'
import { GIT_STYLE, gitMaps, gitPathKey } from '@/lib/git-decorations'
import { api } from './api'
import { SkeletonRows } from './Skeleton'

const FILE_ICON: Record<ReturnType<typeof viewerFor>, IconName> = { markdown: 'arquivo', code: 'codigo', pdf: 'pdf', image: 'imagem', external: 'arquivo' }

// Uma pasta por vez, com as cores do git do explorador do PC; tocar na pasta entra nela, no arquivo abre.
export function FilesPanel({ projectId, dir, onFailed, onDir, onFile }: {
  projectId: string
  dir: string
  onFailed(): void
  onDir(dir: string): void
  onFile(path: string): void
}): React.JSX.Element {
  const [listing, setListing] = useState<MobileDirectory | null>(null)
  const [gitFiles, setGitFiles] = useState<MobileGit['files']>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
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
  const git = useMemo(() => gitMaps(gitFiles), [gitFiles])
  const parts = dir ? dir.split(/[\\/]/) : []
  return <div className={`files-panel ${loading && listing ? 'refreshing' : ''}`}>
    <nav className="files-path" aria-label="Pasta atual">
      <button onClick={() => onDir('')}>Raiz</button>
      {parts.map((part, index) => <Fragment key={index}><span aria-hidden="true">/</span><button onClick={() => onDir(parts.slice(0, index + 1).join('/'))}>{part}</button></Fragment>)}
      <button className="icon-button" aria-label="Atualizar arquivos" disabled={loading} onClick={() => { load(); loadGit() }}><Icon name="atualizar" /></button>
    </nav>
    {error && <p role="alert" className="error">{error}</p>}
    {!listing && !error && <SkeletonRows label="Abrindo a pasta…" row="file-row" count={9} />}
    {listing?.entries.length === 0 && <p className="empty-copy">Pasta vazia.</p>}
    {listing?.entries.map((entry) => {
      const status = (entry.isDir ? git.dirs : git.files).get(gitPathKey(entry.path))
      const style = status ? GIT_STYLE[status] : null
      return <button key={entry.path} className="file-row" onClick={() => (entry.isDir ? onDir(entry.path) : onFile(entry.path))}>
        <Icon name={entry.isDir ? 'projeto' : FILE_ICON[viewerFor(entry.name)]} />
        <span className={`file-name ${style?.className ?? ''}`}>{entry.name}</span>
        {style && !entry.isDir && <small className={style.className}>{style.letter}</small>}
        {entry.isDir && <Icon name="expandir" />}
      </button>
    })}
  </div>
}
