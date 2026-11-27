import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import type { CopiedEntry, FileEntry, TreeUndoStep } from '@shared/ipc'
import type { GitFile } from '@shared/git-types'
import { GIT_STYLE, gitMaps, gitPathKey } from '@/lib/git-decorations'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { useConfirm } from '@/components/ConfirmDialog'
import { FileIcon } from '@/components/FileIcon'
import { ipcErrorMessage, isNotFound } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { VirtualRows, type VirtualRowsApi } from '@/components/VirtualRows'
import { FILE_MIME } from '@/lib/drag'
import { windowsFileUrl } from '@shared/file-url'
import { opensInBrowser } from '@shared/browser-viewable'
import { copyPath } from '@/lib/copied-path'
import { PATHS_MIME } from '@/lib/terminal-drop'
import type { OpenFileOptions } from '@/lib/file-tabs'
import { newEntryProblem, renameProblem } from '@shared/entry-name'

interface Props {
  projectId: string
  projectPath: string
  reloadKey: number
  gitFiles: GitFile[]
  isGitRepo: boolean
  // Clique simples: pré-visualização sem tirar o foco da árvore; Enter e duplo clique: aba fixa, foco no editor.
  onOpenFile(path: string, opts?: OpenFileOptions): void
  // Abas de arquivo acompanham o item movido/renomeado; com alteração não salva dentro dele, nada se move.
  onPathMoved(from: string, to: string): void
  hasUnsavedUnder(rel: string): boolean
  reveal?: { path: string; n: number } | null
  // Cada valor novo fecha todas as pastas abertas.
  collapseAll: number
  // Caminhos relativos ao projeto; '' é a raiz.
  onCompare(left: string, right: string): void
  onOpenTerminal(dir: string): void
  onSearchIn(dir: string): void
}

const key = gitPathKey

// FILE_MIME leva só o primeiro item; a lista inteira de caminhos relativos vai neste (e a de absolutos, em PATHS_MIME).
const FILES_MIME = 'application/x-kora-files'

// A árvore é recriada a cada troca de projeto e de aba do painel; as pastas abertas, o desfazer e o que foi copiado
// duram enquanto o app estiver rodando (na bandeja também) e somem ao fechar.
const expandedByProject = new Map<string, Set<string>>()
interface UndoEntry {
  label: string
  step: TreeUndoStep
}
const undoByProject = new Map<string, UndoEntry[]>()
const UNDO_LIMIT = 50
type Clipboard = { projectId: string; rels: string[]; cut: boolean }
let clipboard: Clipboard | null = null
// "Selecionar para comparar" vale até escolher outro, como no VS Code.
let compareSource: { projectId: string; rel: string } | null = null

type Target = { path: string; isDir: boolean }
type Creating = { parent: string; kind: 'file' | 'dir' }
type Message = { text: string; tone: 'error' | 'info' }

// Altura da classe h-6 das linhas: a lista virtual depende dela.
const ROW_HEIGHT = 24

type TreeRow = { kind: 'entry'; entry: FileEntry; depth: number } | { kind: 'create'; parent: string; depth: number }

const parentOf = (rel: string): string => {
  const i = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'))
  return i < 0 ? '' : rel.slice(0, i)
}
const nameOf = (rel: string): string => rel.split(/[\\/]/).pop() ?? rel
const isInside = (rel: string, dir: string): boolean => rel.toLowerCase().startsWith(dir.toLowerCase() + '\\')
const ancestorsOf = (rel: string): string[] => {
  const parts = rel.split(/[\\/]/)
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('\\'))
}
const quoted = (path: string): string => (path.includes(' ') ? `"${path}"` : path)
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`)
const stepSize = (step: TreeUndoStep): number => (step.kind === 'move' ? step.moves.length : step.items.length)
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])
const CHORD_NOTICE = '(Ctrl+K) pressionado. Aguardando a segunda tecla do atalho…'
// Abaixo disso a colagem termina antes de o aviso aparecer e só piscaria.
const BUSY_DELAY_MS = 300

interface NameFieldProps {
  initial?: string
  placeholder?: string
  // Renomear já começa com o nome selecionado até antes da extensão, como no VS Code.
  selectUntil?: number
  validate(value: string): string | null
  // Erro do main fica no balão com o campo aberto; null é sucesso (quem chamou fecha o campo).
  onCommit(value: string, viaKey: boolean): Promise<string | null>
  onCancel(error: string | null, viaKey: boolean): void
}

// Campo de nome da árvore com o erro num balão logo abaixo, conferido a cada tecla (VS Code). Enter com erro não
// fecha; Esc cancela; sair do campo com nome válido grava e com erro desiste, como o VS Code faz.
function NameField({ initial = '', placeholder, selectUntil, validate, onCommit, onCancel }: NameFieldProps): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [refused, setRefused] = useState<{ value: string; text: string } | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const closed = useRef(false)

  useEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    if (selectUntil !== undefined) input.setSelectionRange(0, selectUntil)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const blank = value.trim() === ''
  const problem = blank ? null : (validate(value) ?? (refused?.value === value ? refused.text : null))

  const close = (error: string | null, viaKey: boolean): void => {
    closed.current = true
    onCancel(error, viaKey)
  }

  const commit = async (viaKey: boolean): Promise<void> => {
    if (busy.current || closed.current) return
    if (blank) return close(null, viaKey)
    if (validate(value)) {
      if (!viaKey) close(null, false)
      return
    }
    busy.current = true
    const error = await onCommit(value, viaKey)
    busy.current = false
    if (error === null) {
      closed.current = true
      return
    }
    // Saiu do campo enquanto o main respondia: o erro vai para o aviso da árvore, sem puxar o foco de volta.
    if (!viaKey || document.activeElement !== ref.current) return close(error, false)
    setRefused({ value, text: error })
  }

  return (
    <div className="relative min-w-0 flex-1" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={problem !== null}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close(null, true)
          }
        }}
        onBlur={() => void commit(false)}
        className={cn(
          'w-full rounded-sm bg-card px-1 text-xs text-foreground outline-none ring-1 select-text',
          problem ? 'ring-destructive' : 'ring-ring'
        )}
      />
      {problem && (
        <div
          role="alert"
          className="absolute inset-x-0 top-full z-20 mt-px rounded-sm border border-destructive bg-card px-1.5 py-1 text-[11px] leading-snug whitespace-normal text-destructive shadow-lg"
        >
          {problem}
        </div>
      )}
    </div>
  )
}

// Selecionar uma pasta e algo de dentro dela e mover/excluir/copiar: o de dentro já vai junto com a pasta.
function outermost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((other) => other !== p && isInside(p, other)))
}

export function FileTree({
  projectId,
  projectPath,
  reloadKey,
  gitFiles,
  isGitRepo,
  onOpenFile,
  onPathMoved,
  hasUnsavedUnder,
  reveal,
  collapseAll,
  onCompare,
  onOpenTerminal,
  onSearchIn
}: Props): React.JSX.Element {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedByProject.get(projectId) ?? new Set())
  const [message, setMessage] = useState<Message | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target | null } | null>(null)
  const [creating, setCreating] = useState<Creating | null>(null)
  const confirm = useConfirm()
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [clip, setClipState] = useState<Clipboard | null>(clipboard)
  const [comparing, setComparingState] = useState(compareSource)
  const [busy, setBusy] = useState<string | null>(null)
  // Ctrl+K pressionado: a próxima tecla completa o acorde (Ctrl+K Ctrl+Shift+C).
  const chordRef = useRef(false)

  const setComparing = (rel: string): void => {
    compareSource = { projectId, rel }
    setComparingState(compareSource)
  }

  const withBusy = async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
    const timer = setTimeout(() => setBusy(label), BUSY_DELAY_MS)
    try {
      return await work()
    } finally {
      clearTimeout(timer)
      setBusy(null)
    }
  }

  const setError = (text: string | null): void => setMessage(text ? { text, tone: 'error' } : null)
  const setNotice = (text: string): void => setMessage({ text, tone: 'info' })
  const setClip = (next: Clipboard | null): void => {
    clipboard = next
    setClipState(next)
  }

  useEffect(() => {
    if (message?.tone !== 'info') return
    const timer = setTimeout(() => setMessage((m) => (m?.tone === 'info' ? null : m)), 8000)
    return () => clearTimeout(timer)
  }, [message])

  const gitByPath = useMemo(() => gitMaps(gitFiles), [gitFiles])

  const loadedRef = useRef(new Set<string>())

  const load = useCallback(
    async (rel: string) => {
      try {
        const entries = await window.kora.listDir(projectId, rel)
        loadedRef.current.add(rel)
        setChildren((prev) => ({ ...prev, [rel]: entries }))
        setMessage((m) => (m?.tone === 'error' ? null : m))
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
        setMessage({ text: ipcErrorMessage(err), tone: 'error' })
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

  // Itens na ordem da tela; setas, Shift+clique e as ações em grupo seguem esta lista.
  const visible = useMemo(() => {
    const list: FileEntry[] = []
    const walk = (rel: string): void => {
      for (const entry of children[rel] ?? []) {
        list.push(entry)
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path)
      }
    }
    walk('')
    return list
  }, [children, expanded])
  const byPath = useMemo(() => new Map(visible.map((entry) => [entry.path, entry])), [visible])

  // As linhas desenhadas, já achatadas: só as perto da área visível existem no DOM (pasta com milhares de arquivos
  // aberta custava segundos por render). O campo de criar aparece no topo da pasta onde o item vai nascer.
  const rows = useMemo(() => {
    const list: TreeRow[] = []
    const walk = (rel: string, depth: number): void => {
      if (creating?.parent === rel) list.push({ kind: 'create', parent: rel, depth })
      for (const entry of children[rel] ?? []) {
        list.push({ kind: 'entry', entry, depth })
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return list
  }, [children, expanded, creating])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const listApi = useRef<VirtualRowsApi | null>(null)
  // O campo de criar ou renomear não pode sumir ao rolar (perderia o que foi digitado).
  const editingIndex = rows.findIndex((row) => (row.kind === 'create' ? true : renaming !== null && row.entry.path === renaming))

  // O campo de criar nasce no topo da pasta, que pode estar fora da área visível: rola até ele.
  useEffect(() => {
    if (!creating) return
    const index = rowsRef.current.findIndex((row) => row.kind === 'create')
    if (index >= 0) listApi.current?.scrollToIndex(index)
  }, [creating])

  // A linha pode não existir no DOM (fora da área visível): rola pelo índice dela na lista.
  const scrollTo = (rel: string): void => {
    requestAnimationFrame(() => {
      const index = rowsRef.current.findIndex((row) => row.kind === 'entry' && row.entry.path === rel)
      if (index >= 0) listApi.current?.scrollToIndex(index)
    })
  }

  const selectOnly = (rel: string | null): void => {
    setPicked(rel ? new Set([rel]) : new Set())
    setCursor(rel)
    setAnchor(rel)
  }

  function setExpandedDirs(next: Set<string>): void {
    expandedRef.current = next
    expandedByProject.set(projectId, next)
    setExpanded(next)
  }

  // Abre as pastas até o item, lê o que faltar e rola até ele.
  const showItem = async (rel: string): Promise<void> => {
    const ancestors = ancestorsOf(rel)
    const next = new Set(expandedRef.current)
    for (const dir of ancestors) next.add(dir)
    setExpandedDirs(next)
    selectOnly(rel)
    await Promise.all(['', ...ancestors].map((dir) => load(dir)))
    scrollTo(rel)
  }

  useEffect(() => {
    if (!reveal) return
    void showItem(reveal.path)
    // Só um pedido novo (n) dispara; load muda junto com o projeto, quando a árvore é outra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.n])

  // A árvore remonta ao voltar para Arquivos com o mesmo valor; só um clique novo fecha.
  const collapseSeen = useRef(collapseAll)
  useEffect(() => {
    if (collapseAll === collapseSeen.current) return
    collapseSeen.current = collapseAll
    setExpandedDirs(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseAll])

  const toggleDir = (rel: string, open = !expanded.has(rel)): void => {
    if (open === expanded.has(rel)) return
    const next = new Set(expanded)
    if (open) {
      next.add(rel)
      if (!children[rel]) void load(rel)
    } else next.delete(rel)
    setExpandedDirs(next)
  }

  const remember = (entry: UndoEntry): void => {
    const stack = undoByProject.get(projectId) ?? []
    stack.push(entry)
    if (stack.length > UNDO_LIMIT) stack.shift()
    undoByProject.set(projectId, stack)
  }
  const rememberCopies = (label: string, items: CopiedEntry[]): void => {
    if (items.length) remember({ label, step: { kind: 'remove', items } })
  }

  const reloadAround = (paths: string[]): Promise<unknown> =>
    Promise.all([...new Set(paths.map(parentOf))].filter((dir) => dir === '' || loadedRef.current.has(dir)).map((dir) => load(dir)))

  const startCreating = (parent: string, kind: 'file' | 'dir'): void => {
    if (parent && !expanded.has(parent)) {
      setExpandedDirs(new Set(expanded).add(parent))
      void load(parent)
    }
    setCreating({ parent, kind })
  }

  // Depois que o campo some: focar antes faria o blur dele criar/renomear de novo.
  const refocus = (): void => {
    requestAnimationFrame(() => rootRef.current?.focus())
  }

  // Recusa do main volta para o balão do campo, que continua aberto. Arquivo criado abre numa aba e o foco fica com
  // ela; pasta devolve o foco à árvore.
  const create = async (name: string, viaKey: boolean): Promise<string | null> => {
    if (!creating) return null
    const { parent, kind } = creating
    const result = await window.kora.createEntry(projectId, parent, name, kind)
    if (!result.ok) return result.message
    setCreating(null)
    setError(null)
    if (kind === 'dir' && viaKey) refocus()
    remember({ label: `criar "${nameOf(result.rel)}"`, step: { kind: 'remove', items: [{ rel: result.top, stamp: result.stamp }] } })
    await showItem(result.rel)
    if (kind === 'file') onOpenFile(result.rel)
    return null
  }

  const cancelField = (close: () => void) => (error: string | null, viaKey: boolean): void => {
    close()
    if (error) setError(error)
    if (viaKey) refocus()
  }

  const absolute = (rel: string): string => (rel ? `${projectPath}\\${rel}` : projectPath)
  const act = (fn: () => Promise<unknown>, rel?: string): void => {
    fn().catch((err: unknown) => {
      setError(ipcErrorMessage(err))
      if (rel !== undefined && isNotFound(err)) void load(parentOf(rel))
    })
  }

  const copyPaths = (targets: Target[], relativePaths: boolean): void => {
    if (targets.length === 0) return
    act(() => copyPath(targets.map((t) => (relativePaths ? t.path : absolute(t.path))).join('\n')))
  }

  const unsavedProblem = (rels: string[]): string | null => {
    const dirty = rels.find((rel) => hasUnsavedUnder(rel))
    return dirty ? `Salve (Ctrl+S) as alterações em "${nameOf(dirty)}" antes de mover ou renomear.` : null
  }
  const guardUnsaved = (rels: string[]): boolean => {
    const problem = unsavedProblem(rels)
    if (problem) setError(problem)
    return problem === null
  }

  // O item do clique direito vale sozinho, a menos que faça parte da seleção: aí vale a seleção inteira.
  const targetsFor = (rel: string | null): Target[] => {
    const rels = rel && !picked.has(rel) ? [rel] : visible.filter((e) => picked.has(e.path)).map((e) => e.path)
    return outermost(rels).flatMap((path) => {
      const entry = byPath.get(path)
      return entry ? [{ path, isDir: entry.isDir }] : []
    })
  }

  const trash = async (targets: Target[]): Promise<void> => {
    if (targets.length === 0) return
    const only = targets.length === 1 ? targets[0]! : null
    const ok = await confirm({
      title: only ? `Excluir ${only.isDir ? 'a pasta' : 'o arquivo'} "${nameOf(only.path)}"?` : `Excluir ${targets.length} itens?`,
      message: only
        ? only.isDir
          ? 'A pasta e tudo o que está dentro dela vão para a Lixeira do Windows. Dá para restaurar por lá.'
          : 'O arquivo vai para a Lixeira do Windows. Dá para restaurar por lá.'
        : 'Os itens (com tudo o que houver dentro das pastas) vão para a Lixeira do Windows. Dá para restaurar por lá.',
      confirmLabel: 'Mover para a Lixeira',
      danger: true
    })
    if (!ok) return
    const done: { rel: string; since: number }[] = []
    try {
      for (const { path } of targets) {
        const since = Date.now()
        await window.kora.trashEntry(projectId, path)
        done.push({ rel: path, since })
      }
      // A restauração lê o $Recycle.Bin da unidade; projeto em compartilhamento de rede (\\servidor) não tem um.
      setNotice(/^[a-z]:[\\/]/i.test(projectPath) ? 'Na Lixeira do Windows. Ctrl+Z aqui na árvore restaura.' : 'Excluído.')
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
    if (done.length) {
      remember({ label: `excluir ${plural(done.length, `"${nameOf(done[0]!.rel)}"`, 'itens')}`, step: { kind: 'restore', items: done } })
      selectOnly(null)
    }
    await reloadAround(targets.map((t) => t.path))
  }

  const rename = async (rel: string, name: string, viaKey: boolean): Promise<string | null> => {
    if (name.trim() === nameOf(rel)) {
      setRenaming(null)
      if (viaKey) refocus()
      return null
    }
    const unsaved = unsavedProblem([rel])
    if (unsaved) return unsaved
    try {
      const next = await window.kora.renameEntry(projectId, rel, name)
      setRenaming(null)
      if (viaKey) refocus()
      setError(null)
      selectOnly(next)
      onPathMoved(rel, next)
      remember({ label: `renomear "${nameOf(rel)}"`, step: { kind: 'move', moves: [{ from: rel, to: next }] } })
      await load(parentOf(rel))
      return null
    } catch (err) {
      if (!isNotFound(err)) return ipcErrorMessage(err)
      // Sumiu por fora enquanto o nome era digitado: não há mais o que renomear.
      setRenaming(null)
      setError(ipcErrorMessage(err))
      await load(parentOf(rel))
      return null
    }
  }

  const addToIgnore = (targets: Target[]): void =>
    act(async () => {
      const added = await window.kora.gitAddToIgnore(projectId, targets.map((t) => t.path))
      setNotice(added.length ? `Adicionado ao .gitignore: ${added.join(', ')}` : 'Já estava no .gitignore.')
      await reloadAround(targets.map((t) => t.path))
    })

  const moveMany = async (froms: string[], toDir: string): Promise<void> => {
    const moving = outermost(froms).filter((from) => parentOf(from) !== toDir)
    if (moving.length === 0 || !guardUnsaved(moving)) return
    const moves: { from: string; to: string }[] = []
    let failure: string | null = null
    try {
      for (const from of moving) {
        const to = await window.kora.moveEntry(projectId, from, toDir)
        moves.push({ from, to })
        onPathMoved(from, to)
      }
    } catch (err) {
      failure = ipcErrorMessage(err)
    }
    if (moves.length) {
      remember({ label: `mover ${plural(moves.length, `"${nameOf(moves[0]!.from)}"`, 'itens')}`, step: { kind: 'move', moves } })
      setPicked(new Set(moves.map((m) => m.to)))
      setCursor(moves[0]!.to)
      setAnchor(moves[0]!.to)
    }
    if (toDir && !expandedRef.current.has(toDir)) setExpandedDirs(new Set(expandedRef.current).add(toDir))
    // A mensagem vem depois de recarregar: a listagem bem-sucedida limpa o erro e esconderia a falha.
    await Promise.all([reloadAround(moving), load(toDir)])
    setError(failure)
  }

  const showCopies = async (copied: CopiedEntry[], dirs: string[]): Promise<void> => {
    const next = new Set(expandedRef.current)
    for (const dir of dirs) if (dir) next.add(dir)
    setExpandedDirs(next)
    if (copied.length) {
      setPicked(new Set(copied.map((c) => c.rel)))
      setCursor(copied[0]!.rel)
      setAnchor(copied[0]!.rel)
    }
    await Promise.all(dirs.map((dir) => load(dir)))
    if (copied[0]) scrollTo(copied[0].rel)
  }

  const copyMany = async (rels: string[], toDir: string, label: string): Promise<void> => {
    try {
      const copied = await withBusy('Colando…', () => window.kora.copyEntries(projectId, outermost(rels), toDir))
      setError(null)
      rememberCopies(label, copied)
      await showCopies(copied, [toDir])
    } catch (err) {
      setError(ipcErrorMessage(err))
      void load(toDir)
    }
  }

  const duplicate = async (targets: Target[]): Promise<void> => {
    const byParent = new Map<string, string[]>()
    for (const { path } of targets) byParent.set(parentOf(path), [...(byParent.get(parentOf(path)) ?? []), path])
    const all: CopiedEntry[] = []
    try {
      await withBusy('Duplicando…', async () => {
        for (const [dir, rels] of byParent) all.push(...(await window.kora.copyEntries(projectId, rels, dir)))
      })
      setError(null)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
    rememberCopies(`duplicar ${plural(targets.length, `"${nameOf(targets[0]?.path ?? '')}"`, 'itens')}`, all)
    await showCopies(all, [...byParent.keys()])
  }

  const cutOrCopy = (targets: Target[], cut: boolean): void => {
    if (targets.length === 0) return
    setClip({ projectId, rels: targets.map((t) => t.path), cut })
    setNotice(`${plural(targets.length, `"${nameOf(targets[0]!.path)}"`, 'itens')} ${cut ? 'recortado' : 'copiado'}${targets.length === 1 ? '' : 's'}: Ctrl+V cola na pasta selecionada.`)
  }

  const paste = async (toDir: string): Promise<void> => {
    const current = clipboard
    if (!current || current.projectId !== projectId) return
    if (current.cut) {
      if (!guardUnsaved(current.rels)) return
      // Recortar vale uma vez, como no Explorer: depois de mover, o que estava na área de transferência já mudou de lugar.
      setClip(null)
      await moveMany(current.rels, toDir)
    } else await copyMany(current.rels, toDir, `colar ${plural(current.rels.length, `"${nameOf(current.rels[0]!)}"`, 'itens')}`)
  }

  const undo = async (): Promise<void> => {
    const stack = undoByProject.get(projectId) ?? []
    const entry = stack.pop()
    if (!entry) {
      setNotice('Nada para desfazer na árvore.')
      return
    }
    if (entry.step.kind === 'move' && !guardUnsaved(entry.step.moves.map((m) => m.to))) {
      stack.push(entry)
      return
    }
    const touched =
      entry.step.kind === 'move' ? entry.step.moves.flatMap((m) => [m.from, m.to]) : entry.step.items.map((item) => item.rel)
    let outcome: { error: string } | { done: true }
    try {
      const result = await withBusy('Desfazendo…', () => window.kora.undoTreeStep(projectId, entry.step))
      for (const m of result.moved) onPathMoved(m.from, m.to)
      if (result.message) {
        // O que não foi desfeito (o passo inteiro, se nada mudou) volta para a pilha: resolvido o motivo (arquivo
        // travado, nome ocupado), o Ctrl+Z seguinte tenta só isso.
        const total = stepSize(entry.step)
        const left = result.remaining ? stepSize(result.remaining) : 0
        if (result.remaining) stack.push({ label: entry.label, step: result.remaining })
        const reason = /[.!?]$/.test(result.message) ? result.message : `${result.message}.`
        outcome = {
          error:
            left >= total
              ? `Não deu para desfazer ${entry.label}: ${reason}`
              : `Desfeito só em parte (${total - left} de ${total} itens de ${entry.label}). ${reason}${left ? ' Ctrl+Z tenta de novo o que faltou.' : ''}`
        }
      } else outcome = { done: true }
    } catch (err) {
      outcome = { error: ipcErrorMessage(err) }
    }
    // A mensagem vem depois de recarregar: a listagem bem-sucedida limpa o erro e esconderia a recusa.
    await reloadAround(touched)
    if ('error' in outcome) {
      setError(outcome.error)
      return
    }
    setNotice(`Desfeito: ${entry.label}.`)
    if (entry.step.kind === 'remove') selectOnly(null)
    else {
      const back = entry.step.kind === 'move' ? entry.step.moves.map((m) => m.from) : entry.step.items.map((i) => i.rel)
      setPicked(new Set(back))
      setCursor(back[0] ?? null)
      setAnchor(back[0] ?? null)
      if (back[0]) scrollTo(back[0])
    }
  }

  // Arquivos e pastas do Explorer do Windows entram como cópia; os da própria árvore são movidos.
  const importFrom = async (files: FileList, toDir: string): Promise<void> => {
    const sources = [...files].map((file) => window.kora.pathForFile(file)).filter(Boolean)
    if (sources.length === 0) return
    try {
      const copied = await withBusy('Copiando do Explorer…', () => window.kora.importEntries(projectId, sources, toDir))
      setError(null)
      rememberCopies(`copiar ${plural(copied.length, `"${nameOf(copied[0]?.rel ?? '')}"`, 'itens')} do Explorer`, copied)
      await showCopies(copied, [toDir])
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  // Cada linha solta na pasta dela (a própria, se for pasta; a de cima, se for arquivo). Passar de uma linha para
  // outra da mesma pasta não apaga o destaque.
  const dropProps = (dir: string): React.HTMLAttributes<HTMLDivElement> & { 'data-drop-dir': string } => ({
    'data-drop-dir': dir,
    onDragOver: (e) => {
      const internal = e.dataTransfer.types.includes(FILE_MIME)
      if (!internal && !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
      setDropDir(dir)
    },
    onDragLeave: (e) => {
      const into = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-drop-dir]')?.getAttribute('data-drop-dir') : undefined
      if (!e.currentTarget.contains(e.relatedTarget as Node | null) && into !== dir) setDropDir((d) => (d === dir ? null : d))
    },
    onDrop: (e) => {
      const from = e.dataTransfer.getData(FILE_MIME)
      if (!from && e.dataTransfer.files.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      setDropDir(null)
      if (from) {
        let froms = [from]
        try {
          const list: unknown = JSON.parse(e.dataTransfer.getData(FILES_MIME) || '[]')
          if (Array.isArray(list) && list.length && list.every((p) => typeof p === 'string')) froms = list as string[]
        } catch {
          // Arrasto sem a lista (outra janela do Kora numa versão antiga): vale só o item de FILE_MIME.
        }
        void moveMany(froms, dir)
      } else void importFrom(e.dataTransfer.files, dir)
    }
  })

  const menuItems = (target: Target | null): MenuItem[] => {
    const folder = target === null ? '' : target.isDir ? target.path : parentOf(target.path)
    const canPaste = clip !== null && clip.projectId === projectId
    const creation: MenuItem[] = [
      { label: 'Novo arquivo', icon: <Icon name="novoArquivo" />, onSelect: () => startCreating(folder, 'file') },
      { label: 'Nova pasta', icon: <Icon name="novoProjeto" />, onSelect: () => startCreating(folder, 'dir') }
    ]
    const pasteItem: MenuItem = { label: 'Colar', icon: <Icon name="colar" />, shortcut: 'Ctrl+V', disabled: !canPaste, onSelect: () => void paste(folder) }
    const terminalItem: MenuItem = { label: 'Abrir no terminal integrado', icon: <Icon name="terminal" />, onSelect: () => onOpenTerminal(folder) }
    const searchItem: MenuItem = { label: 'Buscar na pasta…', icon: <Icon name="buscar" />, shortcut: 'Shift+Alt+F', onSelect: () => onSearchIn(folder) }
    if (target === null) {
      return [
        ...creation,
        { label: 'Abrir pasta do projeto no Explorer', icon: <Icon name="pastaAberta" />, shortcut: 'Shift+Alt+R', onSelect: () => act(() => window.kora.revealInExplorer(projectId, '')) },
        terminalItem,
        'separator',
        searchItem,
        'separator',
        pasteItem
      ]
    }
    const targets = targetsFor(target.path)
    const many = targets.length > 1
    const clipboardItems: MenuItem[] = [
      { label: 'Recortar', icon: <Icon name="recortar" />, shortcut: 'Ctrl+X', onSelect: () => cutOrCopy(targets, true) },
      { label: 'Copiar', icon: <Icon name="copiar" />, shortcut: 'Ctrl+C', onSelect: () => cutOrCopy(targets, false) },
      ...(many ? [] : [pasteItem]),
      { label: 'Duplicar', icon: <Icon name="copiar" />, onSelect: () => void duplicate(targets) }
    ]
    const copy: MenuItem[] = [
      { label: many ? 'Copiar caminhos' : 'Copiar caminho', icon: <Icon name="copiar" />, shortcut: 'Shift+Alt+C', onSelect: () => copyPaths(targets, false) },
      { label: many ? 'Copiar caminhos relativos' : 'Copiar caminho relativo', icon: <Icon name="copiar" />, shortcut: 'Ctrl+K Ctrl+Shift+C', onSelect: () => copyPaths(targets, true) }
    ]
    const renameItem: MenuItem = { label: 'Renomear', icon: <Icon name="editar" />, shortcut: 'F2', onSelect: () => setRenaming(target.path) }
    const remove: MenuItem = { label: many ? `Excluir ${targets.length} itens` : 'Excluir', icon: <Icon name="excluir" />, danger: true, shortcut: 'Del', onSelect: () => act(() => trash(targets), target.path) }
    // O .gitignore da raiz não pode ignorar a si mesmo (o main recusa); o que já é ignorado não precisa do item.
    const toIgnore = isGitRepo ? targets.filter((t) => !ignored.has(key(t.path)) && t.path.toLowerCase() !== '.gitignore') : []
    const ignoreItems: MenuItem[] = toIgnore.length
      ? ['separator', { label: 'Adicionar ao .gitignore', icon: <Icon name="git" />, onSelect: () => addToIgnore(toIgnore) }]
      : []
    if (many) {
      const files = targets.filter((t) => !t.isDir)
      const pair: MenuItem[] =
        files.length === 2 && targets.length === 2
          ? [{ label: 'Comparar selecionados', icon: <Icon name="sincronizar" />, onSelect: () => onCompare(files[0]!.path, files[1]!.path) }, 'separator']
          : []
      return [...pair, ...clipboardItems, 'separator', ...copy, ...ignoreItems, 'separator', remove]
    }
    const reveal: MenuItem = {
      label: target.isDir ? 'Abrir no Explorer' : 'Mostrar no Explorer',
      icon: <Icon name="pastaAberta" />,
      shortcut: 'Shift+Alt+R',
      onSelect: () => act(() => window.kora.revealInExplorer(projectId, target.path), target.path)
    }
    const tail: MenuItem[] = ['separator', ...clipboardItems, 'separator', ...copy, ...ignoreItems, 'separator', renameItem, remove]
    if (target.isDir) return [...creation, reveal, terminalItem, 'separator', searchItem, ...tail]
    const left = comparing?.projectId === projectId && comparing.rel !== target.path ? comparing.rel : null
    return [
      { label: 'Abrir', icon: <Icon name="arquivo" />, onSelect: () => onOpenFile(target.path) },
      ...(opensInBrowser(target.path)
        ? [{ label: 'Abrir no navegador padrão', icon: <Icon name="navegador" />, onSelect: () => act(() => window.kora.openInBrowser(projectId, target.path), target.path) }]
        : []),
      { label: 'Abrir no programa padrão', icon: <Icon name="externo" />, onSelect: () => act(() => window.kora.openFile(projectId, target.path), target.path) },
      reveal,
      terminalItem,
      'separator',
      ...creation,
      'separator',
      { label: 'Selecionar para comparar', icon: <Icon name="sincronizar" />, onSelect: () => setComparing(target.path) },
      ...(left ? [{ label: 'Comparar com selecionado', icon: <Icon name="sincronizar" />, onSelect: () => onCompare(left, target.path) }] : []),
      ...tail
    ]
  }

  const openMenu = (e: React.MouseEvent, target: Target | null): void => {
    e.preventDefault()
    e.stopPropagation()
    if (target && !picked.has(target.path)) selectOnly(target.path)
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const clickRow = (e: React.MouseEvent, entry: FileEntry): void => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      setPicked(next)
      setCursor(entry.path)
      setAnchor(entry.path)
      return
    }
    if (e.shiftKey && anchor && byPath.has(anchor)) {
      const from = visible.findIndex((v) => v.path === anchor)
      const to = visible.findIndex((v) => v.path === entry.path)
      setPicked(new Set(visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((v) => v.path)))
      setCursor(entry.path)
      return
    }
    selectOnly(entry.path)
    // O segundo clique de um duplo clique não alterna a pasta de novo (ela ficaria como estava) nem reabre o
    // arquivo: o duplo clique é que fixa a aba.
    if (e.detail > 1) return
    if (entry.isDir) toggleDir(entry.path)
    else onOpenFile(entry.path, { preview: true, focus: false })
  }

  const moveCursor = (index: number, extend: boolean): void => {
    const entry = visible[Math.max(0, Math.min(visible.length - 1, index))]
    if (!entry) return
    if (extend && anchor && byPath.has(anchor)) {
      const from = visible.findIndex((v) => v.path === anchor)
      const to = visible.indexOf(entry)
      setPicked(new Set(visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((v) => v.path)))
      setCursor(entry.path)
    } else selectOnly(entry.path)
    scrollTo(entry.path)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const field = e.target as HTMLElement
    if (renaming || creating || field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') return
    const ctrl = e.ctrlKey || e.metaKey
    const current = cursor ? byPath.get(cursor) : undefined
    const index = current ? visible.indexOf(current) : -1
    const folder = current ? (current.isDir ? current.path : parentOf(current.path)) : ''
    const handled = ((): boolean => {
      if (MODIFIER_KEYS.has(e.key)) return false
      if (chordRef.current) {
        // Como no VS Code, a tecla que não completa o acorde só o cancela.
        chordRef.current = false
        setMessage((m) => (m?.text === CHORD_NOTICE ? null : m))
        if (ctrl && e.shiftKey && !e.altKey && e.code === 'KeyC') copyPaths(targetsFor(null), true)
        return true
      }
      if (ctrl && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
        chordRef.current = true
        setNotice(CHORD_NOTICE)
        return true
      }
      if (e.shiftKey && e.altKey && !ctrl) {
        if (e.code === 'KeyC') copyPaths(targetsFor(null), false)
        else if (e.code === 'KeyR') act(() => window.kora.revealInExplorer(projectId, current?.path ?? ''), current?.path)
        else if (e.code === 'KeyF' && !(current && !current.isDir)) onSearchIn(current?.path ?? '')
        else return false
        return true
      }
      if (ctrl && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'c') cutOrCopy(targetsFor(null), false)
        else if (k === 'x') cutOrCopy(targetsFor(null), true)
        else if (k === 'v') void paste(folder)
        else if (k === 'z') void undo()
        else return false
        return true
      }
      if (ctrl || e.altKey) return false
      switch (e.key) {
        case 'ArrowDown':
          moveCursor(index < 0 ? 0 : index + 1, e.shiftKey)
          return true
        case 'ArrowUp':
          moveCursor(index < 0 ? visible.length - 1 : index - 1, e.shiftKey)
          return true
        case 'Home':
          moveCursor(0, e.shiftKey)
          return true
        case 'End':
          moveCursor(visible.length - 1, e.shiftKey)
          return true
        case 'ArrowRight':
          if (current?.isDir) {
            if (!expanded.has(current.path)) toggleDir(current.path, true)
            else if (visible[index + 1] && parentOf(visible[index + 1]!.path) === current.path) moveCursor(index + 1, false)
          }
          return true
        case 'ArrowLeft':
          if (current?.isDir && expanded.has(current.path)) toggleDir(current.path, false)
          else if (current && parentOf(current.path)) moveCursor(visible.findIndex((v) => v.path === parentOf(current.path)), false)
          return true
        case 'Enter':
          if (!current) return false
          if (current.isDir) toggleDir(current.path)
          else onOpenFile(current.path)
          return true
        case 'Delete':
          act(() => trash(targetsFor(null)))
          return true
        case 'F2':
          if (!current) return false
          setRenaming(current.path)
          return true
        case 'Escape':
          if (picked.size === 0) return false
          selectOnly(null)
          return true
      }
      return false
    })()
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const creationRow = (parent: string, depth: number): React.ReactNode =>
    creating?.parent === parent && (
      <div key={`criar:${parent}`} {...dropProps(parent)} style={{ paddingLeft: 4 + depth * 12 + 16 }} className="flex h-6 items-center gap-1 pr-2">
        {creating.kind === 'dir' ? <Icon name="projeto" className="size-3.5" /> : <FileIcon name="" className="size-3.5" />}
        <NameField
          key={`${creating.parent}|${creating.kind}`}
          placeholder={creating.kind === 'dir' ? 'nome da pasta (ou a/b)' : 'nome do arquivo (ou pasta/arquivo)'}
          validate={(value) => newEntryProblem(value, children[parent] ?? [])}
          onCommit={create}
          onCancel={cancelField(() => setCreating(null))}
        />
      </div>
    )

  const cutPaths = clip?.cut && clip.projectId === projectId ? clip.rels : []

  const renderRow = (row: TreeRow): React.ReactNode => {
    if (row.kind === 'create') return creationRow(row.parent, row.depth)
    const { entry, depth } = row
    const open = expanded.has(entry.path)
    const isIgnored = ignored.has(key(entry.path))
    const isCut = cutPaths.includes(entry.path)
    const git = entry.isDir ? gitByPath.dirs.get(key(entry.path)) : gitByPath.files.get(key(entry.path))
    return (
      <div
        key={entry.path}
        {...dropProps(entry.isDir ? entry.path : parentOf(entry.path))}
        data-tip={entry.path}
        style={{ paddingLeft: 4 + depth * 12 }}
        draggable={renaming !== entry.path}
        onDragStart={(e) => {
          let items = [entry.path]
          if (picked.has(entry.path)) items = outermost(visible.filter((v) => picked.has(v.path)).map((v) => v.path))
          else selectOnly(entry.path)
          e.dataTransfer.setData(FILE_MIME, items[0]!)
          if (items.length > 1) e.dataTransfer.setData(FILES_MIME, JSON.stringify(items))
          e.dataTransfer.setData('text/plain', items.length === 1 ? absolute(items[0]!) : items.map((p) => quoted(absolute(p))).join(' '))
          e.dataTransfer.setData(PATHS_MIME, JSON.stringify(items.map(absolute)))
          // Link file:// é o que o navegador aceita soltar: HTML, PDF e JSON abrem direto numa aba dele.
          const files = items.filter((p) => !byPath.get(p)?.isDir)
          if (files.length) e.dataTransfer.setData('text/uri-list', files.map((p) => windowsFileUrl(absolute(p))).join('\r\n'))
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
        onClick={(e) => clickRow(e, entry)}
        // Pasta: o primeiro clique já expandiu ou recolheu, como no VS Code; renomear é pelo F2 ou pelo menu.
        onDoubleClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || entry.isDir) return
          onOpenFile(entry.path)
        }}
        onContextMenu={(e) => openMenu(e, { path: entry.path, isDir: entry.isDir })}
        className={cn(
          'flex h-6 cursor-default items-center gap-1 rounded pr-2 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
          (menu?.target?.path === entry.path || picked.has(entry.path)) && 'bg-secondary/60 text-foreground',
          cursor === entry.path && 'group-focus:shadow-[inset_0_0_0_1px_var(--ring)]',
          entry.isDir && dropDir === entry.path && 'bg-secondary shadow-[inset_0_0_0_1px_var(--brand-amber)]'
        )}
      >
        <Icon
          name="expandir"
          className={cn('size-3 transition-transform', open && 'rotate-90', !entry.isDir && 'invisible')}
        />
        {/* Na árvore o detalhe da pasta fica cinza: o âmbar em toda linha deixaria de marcar o que está ativo. */}
        {entry.isDir ? (
          <Icon name={open ? 'pastaAberta' : 'projeto'} className={cn('size-3.5', (isIgnored || isCut) && 'opacity-40')} />
        ) : (
          <FileIcon name={entry.name} className={cn('size-3.5', (isIgnored || isCut) && 'opacity-40')} />
        )}
        {renaming === entry.path ? (
          <NameField
            initial={entry.name}
            selectUntil={entry.isDir || entry.name.lastIndexOf('.') <= 0 ? entry.name.length : entry.name.lastIndexOf('.')}
            validate={(value) => renameProblem(value, entry.name, (children[parentOf(entry.path)] ?? []).filter((e) => e.path !== entry.path))}
            onCommit={(value, viaKey) => rename(entry.path, value, viaKey)}
            onCancel={cancelField(() => setRenaming(null))}
          />
        ) : (
          <span
            className={cn(
              'flex-1 truncate',
              isIgnored ? 'text-git-ignored' : git ? GIT_STYLE[git].className : 'text-foreground/85',
              isCut && 'opacity-60'
            )}
          >
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
    )
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      data-file-tree
      data-keeps-focus
      className="group flex min-h-full flex-col px-1 py-1 outline-none"
      onContextMenu={(e) => openMenu(e, null)}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (chordRef.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          chordRef.current = false
          setMessage((m) => (m?.text === CHORD_NOTICE ? null : m))
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) selectOnly(null)
      }}
      {...dropProps('')}
    >
      {busy && (
        <p role="status" className="animate-pulse px-2 py-1 text-xs text-muted-foreground">
          {busy}
        </p>
      )}
      {message && (
        <p className={cn('px-2 py-1 text-xs', message.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{message.text}</p>
      )}
      <VirtualRows items={rows} rowHeight={ROW_HEIGHT} render={renderRow} apiRef={listApi} keepIndex={editingIndex} />
      <div className="min-h-8 flex-1" onClick={() => selectOnly(null)} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}
    </div>
  )
}
