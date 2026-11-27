import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { addEditorAction, disposeDiffEditor, EDITOR_OPTIONS, languageForPath, monaco, themeForDocument } from '@/lib/monaco'
import { ipcErrorMessage, isNotFound } from '@/lib/ipc-error'
import { changeMayRemove } from '@/lib/file-tabs'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/components/ConfirmDialog'
import { headerButton, ViewerHeader } from '@/components/ViewerHeader'

interface Props {
  projectId: string
  projectPath: string
  // Só leitura, à esquerda.
  left: string
  // Editável e salvável com Ctrl+S, à direita.
  right: string
  visible: boolean
  fontSize: number
  wordWrap: boolean
  onDirtyChange(dirty: boolean): void
  // Deixa quem fecha a aba salvar antes; o salvamento pode não acontecer (conflito, erro) e aí devolve false.
  onSaveHandle?(save: (() => Promise<boolean>) | null): void
  onOpenPath(rel: string, line: number | null): void
}

type Load = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }

let modelCounter = 0

// A extensão do caminho escolhe a linguagem; a query deixa as URIs únicas (o mesmo arquivo pode estar aberto em
// outra aba, e o Monaco recusa dois models com a mesma URI).
const modelUri = (side: string, projectId: string, path: string): monaco.Uri =>
  monaco.Uri.file(`/${projectId}/${path.replace(/\\/g, '/')}`).with({ query: `compare=${side}-${++modelCounter}` })

// O getValue padrão descarta o BOM: salvar sem mudar nada reescreveria o arquivo sem ele.
const contentOf = (model: monaco.editor.ITextModel): string => model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true)

// Depois de aberto, o arquivo continua na comparação mesmo que cresça além do limite normal de abertura.
const OPEN_ALREADY = { force: true }

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path
const bannerButton = 'rounded-md border border-current/30 px-2 py-0.5 hover:bg-white/10 disabled:opacity-50'

export function CompareView(props: Props): React.JSX.Element {
  const { projectId, projectPath, left, right, visible, fontSize, wordWrap, onDirtyChange, onSaveHandle, onOpenPath } = props
  const confirm = useConfirm()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null)
  const mtimeRef = useRef(0)
  const encodingIdRef = useRef<string | undefined>(undefined)
  const savedVersionRef = useRef(0)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const checkAfterBusyRef = useRef(false)
  const onDirtyRef = useRef(onDirtyChange)
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const checkRightRef = useRef<() => Promise<void>>(async () => {})
  const fontSizeRef = useRef(fontSize)
  const wordWrapRef = useRef(wordWrap)

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [rightDeleted, setRightDeleted] = useState(false)
  const [leftDeleted, setLeftDeleted] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    onDirtyRef.current = onDirtyChange
  }, [onDirtyChange])

  useEffect(() => {
    onSaveHandle?.(async () => {
      await saveRef.current()
      return !dirtyRef.current
    })
    return () => onSaveHandle?.(null)
  }, [onSaveHandle])

  const publishDirty = (next: boolean): void => {
    if (dirtyRef.current === next) return
    dirtyRef.current = next
    setDirty(next)
    onDirtyRef.current(next)
  }

  const refreshDirty = (model: monaco.editor.ITextModel): void => publishDirty(model.getAlternativeVersionId() !== savedVersionRef.current)

  const markSaved = (model: monaco.editor.ITextModel, mtimeMs: number, version: number): void => {
    mtimeRef.current = mtimeMs
    savedVersionRef.current = version
    refreshDirty(model)
  }

  useEffect(() => {
    let cancelled = false
    let editor: monaco.editor.IStandaloneDiffEditor | undefined
    let models: { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | undefined
    setLoad({ status: 'loading' })
    setConflict(false)
    setRightDeleted(false)
    setLeftDeleted(false)
    setNotice(null)

    const read = (path: string): Promise<Awaited<ReturnType<typeof window.kora.readText>>> =>
      window.kora.readText(projectId, path).catch((err: unknown) => {
        throw new Error(isNotFound(err) ? ipcErrorMessage(err, path) : `${nameOf(path)}: ${ipcErrorMessage(err)}`)
      })

    Promise.all([read(left), read(right)]).then(
      ([leftFile, rightFile]) => {
        if (cancelled || !hostRef.current) return
        const original = monaco.editor.createModel(leftFile.content, languageForPath(left), modelUri('original', projectId, left))
        const modified = monaco.editor.createModel(rightFile.content, languageForPath(right), modelUri('modified', projectId, right))
        models = { original, modified }
        editor = monaco.editor.createDiffEditor(hostRef.current, {
          ...EDITOR_OPTIONS,
          fontSize: fontSizeRef.current,
          wordWrap: wordWrapRef.current ? 'on' : 'off',
          theme: themeForDocument(),
          originalEditable: false,
          renderSideBySide: true
        })
        editor.setModel(models)
        editorRef.current = editor
        modelsRef.current = models
        encodingIdRef.current = rightFile.encodingId
        markSaved(modified, rightFile.mtimeMs, modified.getAlternativeVersionId())
        modified.onDidChangeContent(() => refreshDirty(modified))
        // addAction no editor da direita: o atalho de addCommand vale para o último editor criado, não para o que
        // tem foco, e salvaria o arquivo de outra aba.
        addEditorAction(editor.getModifiedEditor(), {
          id: 'kora.save',
          label: 'Salvar',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => void saveRef.current()
        })
        setLoad({ status: 'ready' })
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    )

    return () => {
      cancelled = true
      editorRef.current = null
      modelsRef.current = null
      if (editor) disposeDiffEditor(editor)
      models?.original.dispose()
      models?.modified.dispose()
      publishDirty(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, left, right, reloadKey])

  useEffect(() => {
    fontSizeRef.current = fontSize
    editorRef.current?.updateOptions({ fontSize })
  }, [fontSize])

  useEffect(() => {
    wordWrapRef.current = wordWrap
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
  }, [wordWrap])

  useEffect(() => {
    if (visible && load.status === 'ready') editorRef.current?.getModifiedEditor().focus()
  }, [visible, load.status])

  const withBusy = async (task: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      await task()
    } catch (err) {
      setNotice(ipcErrorMessage(err))
    } finally {
      busyRef.current = false
      setBusy(false)
      if (checkAfterBusyRef.current) {
        checkAfterBusyRef.current = false
        void checkRightRef.current()
      }
    }
  }

  // Mesma proteção do editor: o main recusa gravar se o arquivo mudou no disco depois do último mtime conhecido.
  // Arquivo apagado ou movido: o main recria ao salvar, sem checar o mtime antigo.
  const write = async (model: monaco.editor.ITextModel, expectedMtimeMs: number): Promise<void> => {
    const version = model.getAlternativeVersionId()
    const result = await window.kora.writeText(projectId, right, contentOf(model), expectedMtimeMs, encodingIdRef.current)
    if (result.ok) {
      setConflict(false)
      setRightDeleted(false)
      markSaved(model, result.mtimeMs, version)
    } else if (result.conflict) {
      setConflict(true)
    } else {
      setNotice(result.message)
    }
  }

  const save = (): Promise<void> =>
    withBusy(async () => {
      const model = modelsRef.current?.modified
      if (model) await write(model, mtimeRef.current)
    })

  useEffect(() => {
    saveRef.current = save
  })

  // Relê só para pegar o mtime atual; o conteúdo gravado continua sendo o da comparação.
  const overwrite = (): Promise<void> =>
    withBusy(async () => {
      const model = modelsRef.current?.modified
      if (!model) return
      const fresh = await window.kora.readText(projectId, right, OPEN_ALREADY)
      await write(model, fresh.mtimeMs)
    })

  const reloadRight = (): Promise<void> =>
    withBusy(async () => {
      const model = modelsRef.current?.modified
      if (!model) return
      const fresh = await window.kora.readText(projectId, right, OPEN_ALREADY)
      model.setValue(fresh.content)
      encodingIdRef.current = fresh.encodingId
      setConflict(false)
      setRightDeleted(false)
      markSaved(model, fresh.mtimeMs, model.getAlternativeVersionId())
    })

  const reloadLeft = async (): Promise<void> => {
    const models = modelsRef.current
    if (!models) return
    const fresh = await window.kora.readText(projectId, left, OPEN_ALREADY).catch((err: unknown) => (isNotFound(err) ? 'missing' : null))
    if (!fresh || modelsRef.current !== models) return
    if (fresh === 'missing') return setLeftDeleted(true)
    setLeftDeleted(false)
    if (models.original.getValue() !== fresh.content.replace(/^﻿/, '')) models.original.setValue(fresh.content)
  }

  // O watcher também avisa as gravações do próprio Kora: só o mtime diferente do último lido ou salvo conta como
  // mudança de fora. Com edição pendente vira conflito; sem, o lado direito acompanha o disco.
  const checkRight = async (): Promise<void> => {
    const model = modelsRef.current?.modified
    if (!model) return
    if (busyRef.current) {
      checkAfterBusyRef.current = true
      return
    }
    const known = mtimeRef.current
    const fresh = await window.kora.readText(projectId, right, OPEN_ALREADY).catch((err: unknown) => (isNotFound(err) ? 'missing' : null))
    if (!fresh || modelsRef.current?.modified !== model) return
    if (busyRef.current) {
      checkAfterBusyRef.current = true
      return
    }
    if (fresh === 'missing') return setRightDeleted(true)
    setRightDeleted(false)
    if (mtimeRef.current !== known) return void checkRightRef.current()
    if (fresh.mtimeMs === known) return
    encodingIdRef.current = fresh.encodingId
    if (fresh.content === contentOf(model)) {
      markSaved(model, fresh.mtimeMs, model.getAlternativeVersionId())
      setConflict(false)
    } else if (dirtyRef.current) {
      setConflict(true)
    } else {
      // Edição em vez de setValue: o Ctrl+Z volta para o que estava antes da mudança de fora.
      model.pushStackElement()
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: fresh.content.replace(/^﻿/, '') }], () => null)
      model.pushStackElement()
      markSaved(model, fresh.mtimeMs, model.getAlternativeVersionId())
      setConflict(false)
    }
  }

  useEffect(() => {
    checkRightRef.current = checkRight
  })

  useEffect(
    () =>
      window.kora.onFilesChanged((changedProject, change) => {
        if (changedProject !== projectId) return
        if (changeMayRemove(change, left)) void reloadLeft()
        if (changeMayRemove(change, right)) void checkRightRef.current()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, left, right]
  )

  const onHeaderReload = async (): Promise<void> => {
    if (!modelsRef.current) return setReloadKey((k) => k + 1)
    if (dirtyRef.current) {
      const discard = await confirm({
        title: 'Recarregar do disco?',
        message: `As alterações em "${nameOf(right)}" feitas desde o último Ctrl+S serão descartadas.`,
        confirmLabel: 'Descartar e recarregar',
        danger: true
      })
      if (!discard) return
    }
    await reloadLeft()
    await reloadRight()
  }

  return (
    <div data-compare-view className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} projectPath={projectPath} path={right} onOpenPath={onOpenPath} onReload={() => void onHeaderReload()}>
        <span className="hidden min-w-0 shrink truncate @lg:block" data-tip={`À esquerda (só leitura): ${left}\nÀ direita (editável): ${right}`}>
          {nameOf(left)} ↔ {nameOf(right)}
        </span>
        {busy ? (
          <span className="shrink-0">Salvando…</span>
        ) : (
          dirty && (
            <span className="flex shrink-0 items-center gap-1.5 text-amber-300" data-tip="Alterações não salvas" data-tip-shortcut="Ctrl+S">
              <span className="size-1.5 rounded-full bg-current" />
              <span className="hidden @lg:inline">Não salvo</span>
            </span>
          )
        )}
        <button
          type="button"
          data-tip="Abrir o arquivo da direita"
          aria-label="Abrir o arquivo da direita"
          onClick={() => onOpenPath(right, null)}
          className={cn(headerButton, 'shrink-0')}
        >
          <Icon name="arquivo" className="size-3.5" />
        </button>
        <button
          type="button"
          data-tip="Salvar o arquivo da direita"
          data-tip-shortcut="Ctrl+S"
          disabled={(!dirty && !rightDeleted) || busy || load.status !== 'ready'}
          onClick={() => void save()}
          className="shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-secondary disabled:cursor-default disabled:text-muted-foreground disabled:opacity-60 disabled:hover:bg-transparent"
        >
          Salvar
        </button>
      </ViewerHeader>

      {leftDeleted && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          <Icon name="alerta" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">"{nameOf(left)}", à esquerda, foi apagado ou movido no disco. A comparação mostra a última versão lida.</span>
        </div>
      )}

      {rightDeleted && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          <Icon name="alerta" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">"{nameOf(right)}", à direita, foi apagado ou movido no disco. Salvar recria o arquivo.</span>
        </div>
      )}

      {conflict && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          <Icon name="alerta" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            "{nameOf(right)}" mudou no disco enquanto você editava. Recarregar descarta as suas alterações; Sobrescrever grava a sua
            versão por cima.
          </span>
          <button type="button" disabled={busy} onClick={() => void reloadRight()} className={bannerButton}>
            Recarregar do disco
          </button>
          <button type="button" disabled={busy} onClick={() => void overwrite()} className={bannerButton}>
            Sobrescrever
          </button>
        </div>
      )}

      {notice && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" data-tip="Fechar aviso" aria-label="Fechar aviso" onClick={() => setNotice(null)} className="rounded p-0.5 hover:bg-white/10">
            <Icon name="fechar" className="size-3.5" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} data-file-text className={cn('absolute inset-0', load.status !== 'ready' && 'invisible')} />
        {load.status === 'loading' && <p className="absolute p-4 text-xs text-muted-foreground">Carregando…</p>}
        {load.status === 'error' && <p className="absolute p-4 text-xs text-destructive">{load.message}</p>}
      </div>
    </div>
  )
}
