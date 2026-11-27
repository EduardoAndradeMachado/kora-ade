import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '@/brand/icons'
import { disposeDiffEditor, EDITOR_OPTIONS, monaco, themeForDocument } from '@/lib/monaco'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { touchesFile } from '@shared/file-change'
import type { GitHunk, GitHunkAction } from '@shared/git-types'
import type { GitDiffTarget } from '@/lib/file-tabs'
import { notifyGitChanged, onGitChanged } from '@/lib/git-refresh'
import { headerButton, ViewerHeader } from '@/components/ViewerHeader'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { useConfirm } from '@/components/ConfirmDialog'

interface Props {
  projectId: string
  projectPath: string
  path: string
  target: GitDiffTarget
  visible: boolean
  fontSize: number
  wordWrap: boolean
  onOpenPath(rel: string, line: number | null): void
}

// diff: os dois lados. added/removed: um lado vazio, mostrado num editor só com as linhas marcadas (o diff do
// Monaco marcaria a linha vazia do outro lado como alterada). file: só o conteúdo, sem comparação.
type Layout = 'diff' | 'added' | 'removed' | 'file'

type Load =
  | { status: 'loading' }
  | { status: 'ready'; layout: Layout; same: boolean }
  | { status: 'binary' }
  | { status: 'missing' }
  | { status: 'error'; message: string }

interface Content {
  original: string
  modified: string
  binary: boolean
  missing: boolean
  hunks: GitHunk[]
}

const SIDE_BY_SIDE_KEY = 'kora.diff.ladoALado'

function readSideBySide(): boolean {
  try {
    return localStorage.getItem(SIDE_BY_SIDE_KEY) !== '0'
  } catch {
    return true
  }
}

// Botão do trecho na margem do editor da direita. Fica no módulo (e não no main.css) por ser só deste visualizador.
const GLYPH_CSS = `
.monaco-editor .kora-hunk-glyph { cursor: pointer; display: flex; align-items: center; justify-content: center; }
.monaco-editor .kora-hunk-glyph::before { font: 600 14px/1 system-ui, sans-serif; color: var(--vscode-editorLineNumber-activeForeground); opacity: 0.6; }
.monaco-editor .kora-hunk-glyph:hover::before { opacity: 1; }
.monaco-editor .kora-hunk-mais::before { content: '+'; }
.monaco-editor .kora-hunk-menos::before { content: '−'; }
`
if (!document.getElementById('kora-hunk-glyph-css')) {
  const style = document.createElement('style')
  style.id = 'kora-hunk-glyph-css'
  style.textContent = GLYPH_CSS
  document.head.appendChild(style)
}

let modelCounter = 0

// A extensão do caminho escolhe a linguagem; a query deixa as URIs únicas (o Monaco recusa duas iguais).
const modelUri = (side: string, projectId: string, path: string): monaco.Uri =>
  monaco.Uri.file(`/${projectId}/${path.replace(/\\/g, '/')}`).with({ query: `diff=${side}-${++modelCounter}` })

const short = (hash: string): string => (/^[0-9a-f]{8,}$/i.test(hash) ? hash.slice(0, 7) : hash)
const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

// Remoção pura (newLines 0) fica marcada na linha de cima, onde o git diz que o trecho saiu.
const hunkLine = (hunk: GitHunk): number => Math.max(1, hunk.newStart)

function layoutOf(target: GitDiffTarget, content: Content): Layout {
  if (target.fileAt) return 'file'
  if (content.original === '' && content.modified !== '') return 'added'
  if (content.modified === '' && content.original !== '') return 'removed'
  return 'diff'
}

export function DiffView({ projectId, projectPath, path, target, visible, fontSize, wordWrap, onOpenPath }: Props): React.JSX.Element {
  const confirm = useConfirm()
  const { staged, commit, origPath, fileAt } = target
  // Diff da árvore de trabalho ou da fila: acompanha o disco e o index, e tem as ações de fila.
  const live = !commit
  // HEAD muda com commit, desfazer e troca de branch; um commit pelo hash, nunca.
  const watch = live || commit === 'HEAD'
  const hostRef = useRef<HTMLDivElement>(null)
  const singleHostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const singleRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null)
  const glyphsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const linesRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const hunksRef = useRef<GitHunk[]>([])
  const loadRef = useRef<() => void>(() => {})
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [hunks, setHunks] = useState<GitHunk[]>([])
  const [changeCount, setChangeCount] = useState(0)
  const [sideBySide, setSideBySide] = useState(readSideBySide)
  const [menu, setMenu] = useState<{ x: number; y: number; hunk: GitHunk } | null>(null)
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const layout = load.status === 'ready' ? load.layout : null
  const single = layout !== null && layout !== 'diff'

  useEffect(() => {
    if (!hostRef.current) return
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      ...EDITOR_OPTIONS,
      fontSize,
      wordWrap: wordWrap ? 'on' : 'off',
      theme: themeForDocument(),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: readSideBySide(),
      // Trecho só de espaços também vai para a fila: escondido, ele nunca teria o botão.
      ignoreTrimWhitespace: false,
      renderMarginRevertIcon: false,
      glyphMargin: true
    })
    const original = monaco.editor.createModel('', undefined, modelUri('original', projectId, path))
    const modified = monaco.editor.createModel('', undefined, modelUri('modified', projectId, path))
    editor.setModel({ original, modified })
    editorRef.current = editor
    modelsRef.current = { original, modified }
    const modifiedEditor = editor.getModifiedEditor()
    glyphsRef.current = modifiedEditor.createDecorationsCollection()

    // Alt+F5 / Shift+Alt+F5 como no VS Code; ação (e não addCommand) para valer só no editor com foco.
    const navigation = [editor.getOriginalEditor(), modifiedEditor].flatMap((inner) => [
      inner.addAction({ id: 'kora.diff.next', label: 'Próxima alteração', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F5], run: () => editor.goToDiff('next') }),
      inner.addAction({
        id: 'kora.diff.previous',
        label: 'Alteração anterior',
        keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.F5],
        run: () => editor.goToDiff('previous')
      })
    ])
    const offDiff = editor.onDidUpdateDiff(() => setChangeCount(editor.getLineChanges()?.length ?? 0))
    const offMouse = modifiedEditor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return
      const line = e.target.position.lineNumber
      const hunk = hunksRef.current.find((h) => hunkLine(h) === line)
      if (!hunk) return
      e.event.preventDefault()
      setMenu({ x: e.event.browserEvent.clientX, y: e.event.browserEvent.clientY, hunk })
    })
    return () => {
      navigation.forEach((d) => d.dispose())
      offDiff.dispose()
      offMouse.dispose()
      editorRef.current = null
      modelsRef.current = null
      glyphsRef.current = null
      disposeDiffEditor(editor)
      original.dispose()
      modified.dispose()
    }
    // fontSize e wordWrap iniciais; as mudanças depois vão pelos efeitos abaixo sem recriar o editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path])

  // O editor de um lado só nasce quando precisa: a maior parte dos diffs tem os dois lados.
  useEffect(() => {
    if (!single || !singleHostRef.current || !modelsRef.current) return
    const models = modelsRef.current
    const editor = monaco.editor.create(singleHostRef.current, {
      ...EDITOR_OPTIONS,
      fontSize,
      wordWrap: wordWrap ? 'on' : 'off',
      theme: themeForDocument(),
      readOnly: true,
      model: layout === 'removed' ? models.original : models.modified
    })
    singleRef.current = editor
    linesRef.current = editor.createDecorationsCollection()
    return () => {
      singleRef.current = null
      linesRef.current = null
      editor.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, layout === 'removed'])

  // Todas as linhas do lado que existe ficam marcadas, menos a última vazia (que só fecha a última quebra).
  useEffect(() => {
    const editor = singleRef.current
    const lines = linesRef.current
    if (!editor || !lines) return
    const model = editor.getModel()
    if (!model || (layout !== 'added' && layout !== 'removed')) return lines.clear()
    let last = model.getLineCount()
    if (last > 1 && model.getLineLength(last) === 0) last--
    lines.set([
      {
        range: new monaco.Range(1, 1, last, 1),
        options: { isWholeLine: true, className: layout === 'added' ? 'line-insert' : 'line-delete' }
      }
    ])
  })

  useEffect(() => {
    hunksRef.current = hunks
    const sign = staged ? 'menos' : 'mais'
    glyphsRef.current?.set(
      live
        ? hunks.map((hunk) => ({
            range: new monaco.Range(hunkLine(hunk), 1, hunkLine(hunk), 1),
            options: {
              glyphMarginClassName: `kora-hunk-glyph kora-hunk-${sign}`,
              glyphMarginHoverMessage: { value: staged ? 'Clique para tirar o trecho da fila' : 'Clique para colocar o trecho na fila ou descartar' }
            }
          }))
        : []
    )
  }, [hunks, live, staged])

  useEffect(() => {
    let cancelled = false
    let pending = false
    let running = false
    const read = async (): Promise<Content> => {
      if (commit && fileAt) {
        const file = await window.kora.gitFileAt(projectId, commit, path)
        return { original: '', modified: file.text, binary: file.binary, missing: !file.exists, hunks: [] }
      }
      if (commit) return { ...(await window.kora.gitCommitDiff(projectId, commit, path, origPath)), missing: false, hunks: [] }
      // Renomeado sai e entra na fila inteiro, com o caminho antigo junto: sem trechos.
      const [diff, list] = await Promise.all([
        window.kora.gitDiff(projectId, path, staged),
        origPath ? Promise.resolve<GitHunk[]>([]) : window.kora.gitHunks(projectId, path, staged).catch(() => [])
      ])
      return { ...diff, missing: false, hunks: list }
    }
    // O watcher manda rajadas: uma leitura por vez, e mais uma no fim se algo mudou no meio.
    const fetchDiff = async (): Promise<void> => {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        const content = await read()
        const models = modelsRef.current
        if (cancelled || !models) return
        if (content.missing) return setLoad({ status: 'missing' })
        if (content.binary) return setLoad({ status: 'binary' })
        if (models.original.getValue() !== content.original) models.original.setValue(content.original)
        if (models.modified.getValue() !== content.modified) models.modified.setValue(content.modified)
        setHunks(content.hunks)
        setLoad({ status: 'ready', layout: layoutOf(target, content), same: content.original === content.modified })
      } catch (err) {
        if (!cancelled) setLoad({ status: 'error', message: ipcErrorMessage(err) })
      } finally {
        running = false
        if (pending && !cancelled) {
          pending = false
          void fetchDiff()
        }
      }
    }
    loadRef.current = () => void fetchDiff()
    void fetchDiff()
    if (!watch) {
      return () => {
        cancelled = true
      }
    }
    const offFiles = window.kora.onFilesChanged((changedProject, change) => {
      if (changedProject === projectId && (change.git || touchesFile(change, path))) void fetchDiff()
    })
    const offGit = onGitChanged(projectId, () => void fetchDiff())
    const onFocus = (): void => void fetchDiff()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      offFiles()
      offGit()
      window.removeEventListener('focus', onFocus)
    }
    // target é recriado a cada render do App; as partes que importam já estão na lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, staged, commit, origPath, fileAt, watch])

  // Ao voltar para a aba, confere de novo: o commit pode ter acontecido com ela escondida.
  useEffect(() => {
    if (visible && watch) loadRef.current()
  }, [visible, watch])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize })
    singleRef.current?.updateOptions({ fontSize })
  }, [fontSize])

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
    singleRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
  }, [wordWrap])

  const toggleSideBySide = (): void => {
    const next = !sideBySide
    setSideBySide(next)
    editorRef.current?.updateOptions({ renderSideBySide: next })
    try {
      localStorage.setItem(SIDE_BY_SIDE_KEY, next ? '1' : '0')
    } catch {
      // A escolha só não fica lembrada para o próximo diff.
    }
  }

  const goTo = (direction: 'next' | 'previous'): void => {
    const editor = editorRef.current
    if (!editor) return
    editor.goToDiff(direction)
    editor.getModifiedEditor().focus()
  }

  const act = async (task: () => Promise<unknown>): Promise<void> => {
    setActionError(null)
    setWorking(true)
    try {
      await task()
      notifyGitChanged(projectId)
      loadRef.current()
    } catch (err) {
      setActionError(ipcErrorMessage(err))
    } finally {
      setWorking(false)
    }
  }

  const applyHunk = async (hunk: GitHunk, action: GitHunkAction): Promise<void> => {
    if (action === 'discard') {
      const ok = await confirm({
        title: 'Descartar este trecho?',
        message: 'As linhas do trecho voltam à versão da fila. Não dá para desfazer.',
        confirmLabel: 'Descartar',
        danger: true
      })
      if (!ok) return
    }
    await act(() => window.kora.gitApplyHunk(projectId, path, staged, hunk.id, action))
  }

  const discardFile = async (): Promise<void> => {
    const ok = await confirm({
      title: `Descartar as alterações em "${nameOf(path)}"?`,
      message: 'O arquivo volta à versão da fila (ou do último commit). Não dá para desfazer.',
      confirmLabel: 'Descartar',
      danger: true
    })
    if (ok) await act(() => window.kora.gitDiscard(projectId, [path]))
  }

  const hunkMenu = (hunk: GitHunk): MenuItem[] =>
    staged
      ? [{ label: 'Tirar trecho da fila', icon: <Icon name="menos" className="size-3.5" />, onSelect: () => void applyHunk(hunk, 'unstage') }]
      : [
          { label: 'Colocar trecho na fila', icon: <Icon name="novaAba" className="size-3.5" />, onSelect: () => void applyHunk(hunk, 'stage') },
          { label: 'Descartar trecho', danger: true, icon: <Icon name="descartar" className="size-3.5" />, onSelect: () => void applyHunk(hunk, 'discard') }
        ]

  const sides = fileAt
    ? { label: commit === 'HEAD' ? 'HEAD' : short(commit ?? ''), tip: 'Conteúdo do arquivo neste commit, só leitura' }
    : commit
      ? { label: `${short(commit)}^ ↔ ${short(commit)}`, tip: 'Versão anterior ao commit à esquerda, versão do commit à direita' }
      : staged
        ? { label: 'HEAD ↔ na fila', tip: 'Último commit (HEAD) à esquerda, versão na fila à direita' }
        : { label: 'na fila ↔ disco', tip: 'Versão na fila à esquerda, arquivo no disco à direita' }

  const ready = load.status === 'ready'
  const canNavigate = ready && layout === 'diff' && changeCount > 0
  const fileActions: { label: string; icon: IconName; danger?: boolean; run(): void }[] = !live
    ? []
    : staged
      ? [{ label: 'Tirar da fila', icon: 'menos', run: () => void act(() => window.kora.gitUnstage(projectId, origPath ? [path, origPath] : [path])) }]
      : [
          { label: 'Descartar alterações', icon: 'descartar', danger: true, run: () => void discardFile() },
          { label: 'Colocar na fila', icon: 'novaAba', run: () => void act(() => window.kora.gitStage(projectId, [path])) }
        ]

  return (
    <div data-diff-view={commit ? 'commit' : staged ? 'staged' : 'working'} className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={() => loadRef.current()}>
        {origPath && (
          <span className="min-w-0 truncate" data-tip={`Renomeado de ${origPath}`}>
            {nameOf(origPath)} ↔ {nameOf(path)}
          </span>
        )}
        {layout === 'added' && <span className="shrink-0">Todas as linhas adicionadas</span>}
        {layout === 'removed' && <span className="shrink-0">Todas as linhas removidas</span>}
        <span className="shrink-0" data-tip={sides.tip}>
          {sides.label}
        </span>
        {layout === 'diff' && (
          <>
            <button type="button" disabled={!canNavigate} data-tip="Alteração anterior" data-tip-shortcut="Shift+Alt+F5" aria-label="Alteração anterior" onClick={() => goTo('previous')} className={cn(headerButton, 'shrink-0 disabled:opacity-40 disabled:hover:bg-transparent')}>
              <Icon name="setaCima" className="size-3.5" />
            </button>
            <button type="button" disabled={!canNavigate} data-tip="Próxima alteração" data-tip-shortcut="Alt+F5" aria-label="Próxima alteração" onClick={() => goTo('next')} className={cn(headerButton, 'shrink-0 disabled:opacity-40 disabled:hover:bg-transparent')}>
              <Icon name="setaBaixo" className="size-3.5" />
            </button>
            <button
              type="button"
              aria-pressed={sideBySide}
              data-tip={sideBySide ? 'Mostrar o diff em linha' : 'Mostrar o diff lado a lado'}
              aria-label={sideBySide ? 'Mostrar o diff em linha' : 'Mostrar o diff lado a lado'}
              onClick={toggleSideBySide}
              className={cn(headerButton, 'shrink-0')}
            >
              <Icon name="painel" className="size-3.5" />
            </button>
          </>
        )}
        {fileActions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={working}
            data-tip={action.label}
            aria-label={action.label}
            onClick={action.run}
            className={cn(headerButton, 'shrink-0 disabled:opacity-40', action.danger && 'hover:text-destructive')}
          >
            <Icon name={action.icon} className="size-3.5" />
          </button>
        ))}
        <button type="button" data-tip="Abrir o arquivo" aria-label="Abrir o arquivo" onClick={() => onOpenPath(path, null)} className={cn(headerButton, 'shrink-0')}>
          <Icon name="arquivo" className="size-3.5" />
        </button>
      </ViewerHeader>
      {ready && load.same && layout === 'diff' && (
        <p role="status" className="shrink-0 border-b bg-secondary/40 px-4 py-1 text-xs text-muted-foreground">
          {origPath ? 'Só renomeado: o conteúdo é igual dos dois lados.' : 'Sem diferenças: os dois lados são iguais.'}
          {live && !origPath && (staged ? ' Nada deste arquivo está na fila agora.' : ' Não há alteração fora da fila neste arquivo.')}
        </p>
      )}
      {actionError && <p className="shrink-0 border-b px-4 py-1 text-xs text-destructive select-text">{actionError}</p>}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} data-file-text className={cn('absolute inset-0', (!ready || single) && 'invisible')} />
        {single && <div ref={singleHostRef} data-file-text className="absolute inset-0" />}
        {load.status === 'loading' && <p className="absolute p-4 text-xs text-muted-foreground">Carregando…</p>}
        {load.status === 'binary' && <p className="absolute p-4 text-xs text-muted-foreground">Arquivo binário: sem diff de texto.</p>}
        {load.status === 'missing' && <p className="absolute p-4 text-xs text-muted-foreground">O arquivo não existe neste commit.</p>}
        {load.status === 'error' && <p className="absolute p-4 text-xs text-destructive">{load.message}</p>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={hunkMenu(menu.hunk)} onClose={() => setMenu(null)} />}
    </div>
  )
}
