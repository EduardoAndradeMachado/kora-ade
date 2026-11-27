import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import type { GitCommitFile, GitLogCommit, GitRef } from '@shared/git-types'
import { GIT_STYLE } from '@/lib/git-decorations'
import { ipcErrorMessage } from '@/lib/ipc-error'
import type { GitDiffOpen } from '@/lib/file-tabs'
import { cn } from '@/lib/utils'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'

const PAGE = 50
const ROW = 'flex h-6 cursor-default items-center gap-1.5 rounded pr-2 text-xs hover:bg-secondary/60'

interface Props {
  projectId: string
  // Muda quando o HEAD ou as refs mudam (commit, push, troca de branch): recarrega a primeira página.
  refreshKey: string
  // Histórico de um arquivo só (seguindo renomeações); null é o do projeto.
  file: string | null
  onClearFile(): void
  onOpenDiff(path: string, staged: boolean, opts: GitDiffOpen): void
}

type Files = GitCommitFile[] | 'loading' | { error: string }

const REF_STYLE: Record<GitRef['kind'], string> = {
  branch: 'border-[#895503]/50 text-[#895503] dark:border-[#e2c08d]/50 dark:text-[#e2c08d]',
  remote: 'border-border text-muted-foreground',
  tag: 'border-[#1a6fb5]/50 text-[#1a6fb5] dark:border-[#75beff]/50 dark:text-[#75beff]',
  head: 'border-border text-foreground'
}

function RefBadge({ gitRef }: { gitRef: GitRef }): React.JSX.Element {
  return (
    <span
      className={cn('max-w-24 shrink-0 truncate rounded border px-1 text-[10px] leading-4', REF_STYLE[gitRef.kind], gitRef.current && 'font-semibold')}
    >
      {gitRef.name}
    </span>
  )
}

const fullDate = (unix: number): string =>
  new Date(unix * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

function commitTip(commit: GitLogCommit): string {
  const refs = commit.refs.map((r) => (r.kind === 'tag' ? `tag ${r.name}` : r.name)).join(', ')
  return [
    commit.subject,
    commit.body,
    `${commit.author} <${commit.email}> · ${fullDate(commit.date)} (${commit.relative})`,
    refs,
    commit.hash,
    'Clique para ver os arquivos do commit'
  ]
    .filter(Boolean)
    .join('\n')
}

const splitPath = (path: string): { name: string; dir: string } => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? { name: path, dir: '' } : { name: path.slice(cut + 1), dir: path.slice(0, cut) }
}

export function HistorySection({ projectId, refreshKey, file, onClearFile, onOpenDiff }: Props): React.JSX.Element {
  const [commits, setCommits] = useState<GitLogCommit[]>([])
  // Formatar a data com Intl é caro, e o painel renderiza de novo a cada mudança no git.
  const tips = useMemo(() => new Map(commits.map((c) => [c.hash, commitTip(c)])), [commits])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [files, setFiles] = useState<Map<string, Files>>(new Map())
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  // Carregar mais e a recarga automática não podem misturar páginas de pedidos diferentes.
  const generation = useRef(0)

  useEffect(() => {
    const mine = ++generation.current
    setLoading(true)
    window.kora
      .gitLog(projectId, { limit: PAGE, path: file ?? undefined })
      .then(
        (page) => {
          if (generation.current !== mine) return
          setCommits(page.commits)
          setHasMore(page.hasMore)
          setError(null)
        },
        (err: unknown) => generation.current === mine && setError(ipcErrorMessage(err))
      )
      .finally(() => generation.current === mine && setLoading(false))
  }, [projectId, refreshKey, file])

  useEffect(() => {
    setExpanded(new Set())
  }, [file])

  const loadMore = (): void => {
    const mine = ++generation.current
    setLoading(true)
    window.kora
      .gitLog(projectId, { skip: commits.length, limit: PAGE, path: file ?? undefined })
      .then(
        (page) => {
          if (generation.current !== mine) return
          setCommits((list) => [...list, ...page.commits.filter((c) => !list.some((o) => o.hash === c.hash))])
          setHasMore(page.hasMore)
        },
        (err: unknown) => generation.current === mine && setError(ipcErrorMessage(err))
      )
      .finally(() => generation.current === mine && setLoading(false))
  }

  const toggle = (hash: string): void => {
    const next = new Set(expanded)
    if (next.has(hash)) {
      next.delete(hash)
      setExpanded(next)
      return
    }
    next.add(hash)
    setExpanded(next)
    const known = files.get(hash)
    if (Array.isArray(known) || known === 'loading') return
    setFiles((map) => new Map(map).set(hash, 'loading'))
    window.kora.gitCommitFiles(projectId, hash).then(
      (list) => setFiles((map) => new Map(map).set(hash, list)),
      (err: unknown) => setFiles((map) => new Map(map).set(hash, { error: ipcErrorMessage(err) }))
    )
  }

  const copy = (text: string): void => void navigator.clipboard.writeText(text)

  const commitMenu = (e: React.MouseEvent, commit: GitLogCommit): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copiar hash do commit', icon: <Icon name="copiar" className="size-3.5" />, onSelect: () => copy(commit.hash) },
        { label: 'Copiar mensagem do commit', onSelect: () => copy(commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject) }
      ]
    })
  }

  const openFile = (commit: GitLogCommit, f: GitCommitFile, preview: boolean): void =>
    onOpenDiff(f.path, false, { commit: commit.hash, ...(f.origPath ? { origPath: f.origPath } : {}), preview })

  return (
    <div data-git-history>
      {file && (
        <div className="flex h-6 items-center gap-1.5 pl-4 pr-2 text-[11px] text-muted-foreground">
          <Icon name="arquivo" className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" data-tip={file}>
            Histórico de {splitPath(file).name}
          </span>
          <button
            type="button"
            data-tip="Voltar ao histórico do projeto"
            aria-label="Voltar ao histórico do projeto"
            onClick={onClearFile}
            className="rounded p-0.5 hover:bg-accent hover:text-foreground"
          >
            <Icon name="fechar" className="size-3" />
          </button>
        </div>
      )}
      {error && <p className="break-words px-4 py-1 text-xs text-destructive select-text">{error}</p>}
      {!error && !loading && commits.length === 0 && (
        <p className="px-4 py-1 text-xs text-muted-foreground">{file ? 'Nenhum commit com este arquivo.' : 'Ainda não há commits.'}</p>
      )}
      {commits.map((commit) => {
        const open = expanded.has(commit.hash)
        const list = files.get(commit.hash)
        return (
          <div key={commit.hash}>
            <div
              data-git-commit={commit.hash}
              data-tip={tips.get(commit.hash)}
              onClick={() => toggle(commit.hash)}
              onContextMenu={(e) => commitMenu(e, commit)}
              className={cn(ROW, 'pl-1')}
            >
              <Icon name="expandir" className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
              {commit.refs.map((r) => (
                <RefBadge key={`${r.kind}:${r.name}`} gitRef={r} />
              ))}
              <span className="min-w-0 flex-1 truncate text-foreground">{commit.subject || '(sem mensagem)'}</span>
              <span className="max-w-20 shrink-0 truncate text-[10px] text-muted-foreground">{commit.author}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/80">{commit.relative}</span>
            </div>
            {open && list === 'loading' && <p className="py-0.5 pl-8 text-[11px] text-muted-foreground">Carregando…</p>}
            {open && list && !Array.isArray(list) && list !== 'loading' && (
              <p className="break-words py-0.5 pl-8 text-[11px] text-destructive select-text">{list.error}</p>
            )}
            {open && Array.isArray(list) && list.length === 0 && (
              <p className="py-0.5 pl-8 text-[11px] text-muted-foreground">Nenhum arquivo alterado neste projeto.</p>
            )}
            {open &&
              Array.isArray(list) &&
              list.map((f) => {
                const { name, dir } = splitPath(f.path)
                const style = GIT_STYLE[f.status]
                return (
                  <div
                    key={f.path}
                    data-git-commit-file={f.path}
                    data-tip={`${f.origPath ? `${f.origPath} → ${f.path}` : f.path}\nClique para ver o diff neste commit`}
                    onClick={() => openFile(commit, f, true)}
                    onDoubleClick={() => openFile(commit, f, false)}
                    className={cn(ROW, 'pl-8')}
                  >
                    <Icon name="arquivo" className={cn('size-3.5 shrink-0 text-muted-foreground', f.status === 'deleted' && 'opacity-50')} />
                    <span className={cn('min-w-0 truncate text-foreground', f.status === 'deleted' && 'line-through opacity-70')}>{name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
                    <span className={cn('w-3 shrink-0 text-center font-mono text-[11px]', style.className)}>{style.letter}</span>
                  </div>
                )
              })}
          </div>
        )
      })}
      {loading && <p className="px-4 py-1 text-xs text-muted-foreground">Carregando…</p>}
      {hasMore && !loading && (
        <button type="button" onClick={loadMore} className={cn(ROW, 'w-full pl-4 text-muted-foreground hover:text-foreground')}>
          Carregar mais commits
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
