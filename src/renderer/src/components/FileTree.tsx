import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '@/brand/icons'
import type { FileEntry } from '@shared/ipc'
import type { GitFile, GitFileStatus } from '@shared/git-types'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { useConfirm } from '@/components/ConfirmDialog'
import { ipcErrorMessage, isNotFound } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { FILE_MIME } from '@/lib/drag'
import { windowsFileUrl } from '@shared/file-url'

interface Props {
  projectId: string
  projectPath: string
  reloadKey: number
  gitFiles: GitFile[]
  onOpenFile(path: string): void
  // Abas de arquivo acompanham o item movido/renomeado; com alteração não salva dentro dele, nada se move.
  onPathMoved(from: string, to: string): void
  hasUnsavedUnder(rel: string): boolean
  reveal?: { path: string; n: number } | null
}

// Mesmas cores do VS Code: claras no tema escuro, escuras no claro para manter contraste.
const GIT_STYLE: Record<GitFileStatus, { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-[#895503] dark:text-[#e2c08d]' },
  added: { letter: 'A', className: 'text-[#587c0c] dark:text-[#73c991]' },
  untracked: { letter: 'U', className: 'text-[#587c0c] dark:text-[#73c991]' },
  renamed: { letter: 'R', className: 'text-[#007acc] dark:text-[#73c991]' },
  deleted: { letter: 'D', className: 'text-[#ad0707] dark:text-[#f48771]' },
  conflicted: { letter: '!', className: 'text-[#ad0707] dark:text-[#e06c75]' }
}

const key = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

type Target = { path: string; isDir: boolean } | null
type Creating = { parent: string; kind: 'file' | 'dir' }

const parentOf = (rel: string): string => {
  const i = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'))
  return i < 0 ? '' : rel.slice(0, i)
}

export function FileTree({ projectId, projectPath, reloadKey, gitFiles, onOpenFile, onPathMoved, hasUnsavedUnder, reveal }: Props): React.JSX.Element {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target } | null>(null)
  const [creating, setCreating] = useState<Creating | null>(null)
  const confirm = useConfirm()
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)

  const gitByPath = useMemo(() => {
    const files = new Map<string, GitFileStatus>()
    const dirs = new Map<string, GitFileStatus>()
    for (const f of gitFiles) {
      files.set(key(f.path), f.status)
      const parts = key(f.path).split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        // Conflito vence qualquer outro status na pasta; depois, modificado.
        const current = dirs.get(dir)
        if (current !== 'conflicted' && (f.status === 'conflicted' || !current || current === 'untracked')) {
          dirs.set(dir, f.status === 'untracked' || f.status === 'added' ? (current ?? f.status) : f.status)
        }
      }
    }
    return { files, dirs }
  }, [gitFiles])

  const loadedRef = useRef(new Set<string>())

  const load = useCallback(
    async (rel: string) => {
      try {
        const entries = await window.kora.listDir(projectId, rel)
        loadedRef.current.add(rel)
        setChildren((prev) => ({ ...prev, [rel]: entries }))
        setError(null)
        // Pasta precisa da barra final: regras como "node_modules/" só casam com diretório.
        const queries = entries.map((e) => e.path.replace(/\\/g, '/') + (e.isDir ? '/' : ''))
        window.kora.gitIgnored(projectId, queries).then(
          (hits) =>
            setIgnored((prev) => {
              const next = new Set(prev)
              for (const q of queries) next.delete(key(q.replace(/\/$/, '')))
              for (const h of hits) next.add(key(h.replace(/\/$/, '')))
              return next
            }),
          () => {}
        )
      } catch (err) {
        // Subpasta apagada ou movida por fora: some da árvore junto com o que estava aberto nela.
        if (rel && isNotFound(err)) {
          loadedRef.current.delete(rel)
          setChildren((prev) => {
            const next = { ...prev }
            delete next[rel]
            return next
          })
          return
        }
        setError(ipcErrorMessage(err))
      }
    },
    [projectId]
  )

  const expandedRef = useRef(expanded)

  useEffect(() => {
    setChildren({})
    loadedRef.current.clear()
    void load('')
    for (const rel of expandedRef.current) void load(rel)
  }, [load, reloadKey])

  // Só relê o que já foi aberto: pasta nunca expandida é lida quando o usuário abrir. Regra de ignorados nova
  // pode mudar qualquer item já mostrado, então tudo o que está aberto é relido (e reconsultado no git).
  useEffect(
    () =>
      window.kora.onFilesChanged((changedProject, change) => {
        if (changedProject !== projectId) return
        const dirs = change.rescan || change.ignoreRules ? [...loadedRef.current] : change.dirs
        for (const dir of dirs) if (loadedRef.current.has(dir)) void load(dir)
      }),
    [projectId, load]
  )

  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!reveal) return
    const parts = reveal.path.split(/[\\/]/)
    const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('\\'))
    const next = new Set(expandedRef.current)
    for (const dir of ancestors) next.add(dir)
    expandedRef.current = next
    setExpanded(next)
    setSelected(reveal.path)
    void Promise.all(ancestors.map((dir) => load(dir))).then(() =>
      requestAnimationFrame(() =>
        rootRef.current?.querySelector(`[title="${CSS.escape(reveal.path)}"]`)?.scrollIntoView({ block: 'nearest' })
      )
    )
    // Só um pedido novo (n) dispara; load muda junto com o projeto, quando a árvore é outra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.n])

  const setExpandedDirs = (next: Set<string>): void => {
    expandedRef.current = next
    setExpanded(next)
  }

  const toggleDir = (rel: string): void => {
    const next = new Set(expanded)
    if (next.has(rel)) next.delete(rel)
    else {
      next.add(rel)
      if (!children[rel]) void load(rel)
    }
    setExpandedDirs(next)
  }

  const startCreating = (parent: string, kind: 'file' | 'dir'): void => {
    if (parent && !expanded.has(parent)) {
      setExpandedDirs(new Set(expanded).add(parent))
      void load(parent)
    }
    setCreating({ parent, kind })
  }

  const create = async (name: string): Promise<void> => {
    if (!creating) return
    const { parent, kind } = creating
    setCreating(null)
    if (!name.trim()) return
    const result = await window.kora.createEntry(projectId, parent, name, kind)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(null)
    await load(parent)
    if (kind === 'file') onOpenFile(result.rel)
  }

  const trash = async (target: { path: string; isDir: boolean }): Promise<void> => {
    const name = target.path.split(/[\\/]/).pop() ?? target.path
    const ok = await confirm({
      title: `Excluir ${target.isDir ? 'a pasta' : 'o arquivo'} "${name}"?`,
      message: target.isDir
        ? 'A pasta e tudo o que está dentro dela vão para a Lixeira do Windows. Dá para restaurar por lá.'
        : 'O arquivo vai para a Lixeira do Windows. Dá para restaurar por lá.',
      confirmLabel: 'Mover para a Lixeira',
      danger: true
    })
    if (!ok) return
    await window.kora.trashEntry(projectId, target.path)
    await load(parentOf(target.path))
  }

  const absolute = (rel: string): string => (rel ? `${projectPath}\\${rel}` : projectPath)
  const act = (fn: () => Promise<unknown>, rel?: string): void => {
    fn().catch((err: unknown) => {
      setError(ipcErrorMessage(err))
      if (rel !== undefined && isNotFound(err)) void load(parentOf(rel))
    })
  }

  const nameOf = (rel: string): string => rel.split(/[\\/]/).pop() ?? rel

  const guardUnsaved = (rel: string): boolean => {
    if (!hasUnsavedUnder(rel)) return true
    setError(`Salve (Ctrl+S) as alterações em "${nameOf(rel)}" antes de mover ou renomear.`)
    return false
  }

  const rename = async (rel: string, name: string): Promise<void> => {
    setRenaming(null)
    if (!name.trim() || name.trim() === nameOf(rel) || !guardUnsaved(rel)) return
    try {
      const next = await window.kora.renameEntry(projectId, rel, name)
      setError(null)
      setSelected(next)
      onPathMoved(rel, next)
      await load(parentOf(rel))
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const move = async (from: string, toDir: string): Promise<void> => {
    if (parentOf(from) === toDir || !guardUnsaved(from)) return
    try {
      const next = await window.kora.moveEntry(projectId, from, toDir)
      setError(null)
      setSelected(next)
      onPathMoved(from, next)
      if (toDir && !expanded.has(toDir)) setExpandedDirs(new Set(expanded).add(toDir))
      await Promise.all([load(parentOf(from)), load(toDir)])
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const dropProps = (dir: string): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(FILE_MIME)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropDir !== dir) setDropDir(dir)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDir((d) => (d === dir ? null : d))
    },
    onDrop: (e) => {
      const from = e.dataTransfer.getData(FILE_MIME)
      if (!from) return
      e.preventDefault()
      e.stopPropagation()
      setDropDir(null)
      void move(from, dir)
    }
  })

  const menuItems = (target: Target): MenuItem[] => {
    const folder = target === null ? '' : target.isDir ? target.path : parentOf(target.path)
    const creation: MenuItem[] = [
      { label: 'Novo arquivo', onSelect: () => startCreating(folder, 'file') },
      { label: 'Nova pasta', onSelect: () => startCreating(folder, 'dir') }
    ]
    if (target === null) {
      return [...creation, 'separator', { label: 'Abrir pasta do projeto no Explorer', onSelect: () => act(() => window.kora.revealInExplorer(projectId, '')) }]
    }
    const copy: MenuItem[] = [
      { label: 'Copiar caminho', onSelect: () => act(() => navigator.clipboard.writeText(absolute(target.path))) },
      { label: 'Copiar caminho relativo', onSelect: () => act(() => navigator.clipboard.writeText(target.path)) }
    ]
    if (target.isDir) {
      return [
        ...creation,
        'separator',
        { label: 'Abrir no Explorer', onSelect: () => act(() => window.kora.revealInExplorer(projectId, target.path), target.path) },
        { label: 'Renomear', onSelect: () => setRenaming(target.path) },
        ...copy,
        'separator',
        { label: 'Excluir', danger: true, onSelect: () => act(() => trash(target), target.path) }
      ]
    }
    return [
      { label: 'Abrir', onSelect: () => onOpenFile(target.path) },
      { label: 'Abrir no navegador padrão', onSelect: () => act(() => window.kora.openInBrowser(projectId, target.path), target.path) },
      { label: 'Abrir no programa padrão', onSelect: () => act(() => window.kora.openFile(projectId, target.path), target.path) },
      { label: 'Mostrar no Explorer', onSelect: () => act(() => window.kora.revealInExplorer(projectId, target.path), target.path) },
      { label: 'Renomear', onSelect: () => setRenaming(target.path) },
      'separator',
      ...creation,
      'separator',
      ...copy,
      'separator',
      { label: 'Excluir', danger: true, onSelect: () => act(() => trash(target), target.path) }
    ]
  }

  const openMenu = (e: React.MouseEvent, target: Target): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const creationRow = (parent: string, depth: number): React.ReactNode =>
    creating?.parent === parent && (
      <div style={{ paddingLeft: 4 + depth * 12 + 16 }} className="flex h-6 items-center gap-1 pr-2">
        <Icon name={creating.kind === 'dir' ? 'projeto' : 'arquivo'} active={false} className="size-3.5" />
        <input
          autoFocus
          placeholder={creating.kind === 'dir' ? 'nome da pasta' : 'nome do arquivo'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create(e.currentTarget.value)
            if (e.key === 'Escape') setCreating(null)
          }}
          onBlur={(e) => void create(e.currentTarget.value)}
          className="min-w-0 flex-1 rounded-sm bg-card px-1 text-xs outline-none ring-1 ring-ring select-text"
        />
      </div>
    )

  const renderLevel = (rel: string, depth: number): React.ReactNode => (
    <>
      {creationRow(rel, depth)}
      {(children[rel] ?? []).map((entry) => {
        const open = expanded.has(entry.path)
        const isIgnored = ignored.has(key(entry.path))
        const git = entry.isDir ? gitByPath.dirs.get(key(entry.path)) : gitByPath.files.get(key(entry.path))
        // Na árvore o detalhe da pasta fica cinza: o âmbar em toda linha deixaria de marcar o que está ativo.
        const icon: IconName = entry.isDir ? (open ? 'pastaAberta' : 'projeto') : 'arquivo'
        return (
          <div key={entry.path} {...(entry.isDir ? dropProps(entry.path) : {})}>
            <div
              title={entry.path}
              style={{ paddingLeft: 4 + depth * 12 }}
              draggable={renaming !== entry.path}
              onDragStart={(e) => {
                e.dataTransfer.setData(FILE_MIME, entry.path)
                e.dataTransfer.setData('text/plain', absolute(entry.path))
                // Link file:// é o que o navegador aceita soltar: HTML, PDF e JSON abrem direto numa aba dele.
                if (!entry.isDir) e.dataTransfer.setData('text/uri-list', windowsFileUrl(absolute(entry.path)))
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onClick={() => {
                setSelected(entry.path)
                if (entry.isDir) toggleDir(entry.path)
                else onOpenFile(entry.path)
              }}
              // Os dois cliques também alternam a pasta duas vezes, então ela volta ao estado de antes.
              onDoubleClick={() => entry.isDir && setRenaming(entry.path)}
              onContextMenu={(e) => openMenu(e, { path: entry.path, isDir: entry.isDir })}
              className={cn(
                'flex h-6 cursor-default items-center gap-1 rounded pr-2 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                (menu?.target?.path === entry.path || selected === entry.path) && 'bg-secondary/60 text-foreground',
                entry.isDir && dropDir === entry.path && 'bg-secondary shadow-[inset_0_0_0_1px_var(--brand-amber)]'
              )}
            >
              <Icon
                name="expandir"
                className={cn('size-3 transition-transform', open && 'rotate-90', !entry.isDir && 'invisible')}
              />
              <Icon name={icon} active={false} className={cn('size-3.5', isIgnored && 'opacity-40')} />
              {renaming === entry.path ? (
                <input
                  autoFocus
                  defaultValue={entry.name}
                  onFocus={(e) => {
                    const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.')
                    e.currentTarget.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') void rename(entry.path, e.currentTarget.value)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={(e) => void rename(entry.path, e.currentTarget.value)}
                  className="min-w-0 flex-1 rounded-sm bg-card px-1 text-xs text-foreground outline-none ring-1 ring-ring select-text"
                />
              ) : (
                <span className={cn('flex-1 truncate', isIgnored ? 'opacity-45' : git ? GIT_STYLE[git].className : 'text-foreground/85')}>
                  {entry.name}
                </span>
              )}
              {git && !entry.isDir && !isIgnored && (
                <span className={cn('shrink-0 pl-1 text-[10px] font-semibold', GIT_STYLE[git].className)}>{GIT_STYLE[git].letter}</span>
              )}
              {git && entry.isDir && !isIgnored && (
                <span className={cn('size-1.5 shrink-0 rounded-full bg-current', GIT_STYLE[git].className)} />
              )}
            </div>
            {entry.isDir && open && renderLevel(entry.path, depth + 1)}
          </div>
        )
      })}
    </>
  )

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      data-file-tree
      className="flex min-h-full flex-col px-1 py-1 outline-none"
      onContextMenu={(e) => openMenu(e, null)}
      onKeyDown={(e) => {
        if (e.key === 'F2' && selected && !renaming) {
          e.preventDefault()
          setRenaming(selected)
        }
      }}
      {...dropProps('')}
    >
      {error && <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
      {renderLevel('', 0)}
      <div className="min-h-8 flex-1" />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}
    </div>
  )
}
