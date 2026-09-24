import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { EDITOR_OPTIONS, monaco, themeForDocument } from '@/lib/monaco'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/components/ConfirmDialog'
import { ViewerHeader } from '@/components/ViewerHeader'

interface Props {
  projectId: string
  path: string
  visible: boolean
  fontSize: number
  onDirtyChange(dirty: boolean): void
  headerExtra?: React.ReactNode
  // Deixa quem fecha a aba salvar antes; o salvamento pode não acontecer (conflito, erro) e aí devolve false.
  onSaveHandle?(save: (() => Promise<boolean>) | null): void
  jump?: { line: number; n: number }
}

type Load = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }

let duplicateCounter = 0

function modelUri(projectId: string, path: string): monaco.Uri {
  const base = monaco.Uri.file(`/${projectId}/${path.replace(/\\/g, '/')}`)
  // O Monaco recusa dois models com a mesma URI; o mesmo arquivo aberto duas vezes ganha uma query.
  return monaco.editor.getModel(base) ? base.with({ query: `aba=${++duplicateCounter}` }) : base
}

// O getValue padrão descarta o BOM: salvar sem mudar nada reescreveria o arquivo sem ele.
const contentOf = (model: monaco.editor.ITextModel): string =>
  model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true)

const bannerButton = 'rounded-md border border-current/30 px-2 py-0.5 hover:bg-white/10 disabled:opacity-50'

export function CodeView({ projectId, path, visible, fontSize, onDirtyChange, headerExtra, onSaveHandle, jump }: Props): React.JSX.Element {
  const confirm = useConfirm()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const mtimeRef = useRef(0)
  const savedVersionRef = useRef(0)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const onDirtyRef = useRef(onDirtyChange)
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const fontSizeRef = useRef(fontSize)

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
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

  // Versão alternativa em vez de "houve edição": desfazer até o ponto salvo volta a ficar limpo.
  const refreshDirty = (model: monaco.editor.ITextModel): void =>
    publishDirty(model.getAlternativeVersionId() !== savedVersionRef.current)

  const markSaved = (model: monaco.editor.ITextModel, mtimeMs: number, version: number): void => {
    mtimeRef.current = mtimeMs
    savedVersionRef.current = version
    refreshDirty(model)
  }

  useEffect(() => {
    let cancelled = false
    let editor: monaco.editor.IStandaloneCodeEditor | undefined
    let model: monaco.editor.ITextModel | undefined
    setLoad({ status: 'loading' })
    setConflict(false)
    setNotice(null)

    window.kora.readText(projectId, path).then(
      (file) => {
        if (cancelled || !hostRef.current) return
        model = monaco.editor.createModel(file.content, undefined, modelUri(projectId, path))
        editor = monaco.editor.create(hostRef.current, {
          ...EDITOR_OPTIONS,
          fontSize: fontSizeRef.current,
          theme: themeForDocument(),
          model
        })
        editorRef.current = editor
        const loaded = model
        markSaved(loaded, file.mtimeMs, loaded.getAlternativeVersionId())
        loaded.onDidChangeContent(() => refreshDirty(loaded))
        // addAction em vez de addCommand: o atalho de addCommand vale para o último editor
        // criado, não para o que tem foco, e salvaria o arquivo de outra aba.
        editor.addAction({
          id: 'kora.save',
          label: 'Salvar',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => void saveRef.current()
        })
        setLoad({ status: 'ready' })
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: ipcErrorMessage(err) })
      }
    )

    return () => {
      cancelled = true
      editorRef.current = null
      editor?.dispose()
      model?.dispose()
      publishDirty(false)
    }
  }, [projectId, path, reloadKey])

  useEffect(() => {
    fontSizeRef.current = fontSize
    editorRef.current?.updateOptions({ fontSize })
  }, [fontSize])

  useEffect(() => {
    if (visible && load.status === 'ready') editorRef.current?.focus()
  }, [visible, load.status])

  useEffect(() => {
    const editor = editorRef.current
    if (!jump || load.status !== 'ready' || !editor) return
    editor.revealLineInCenter(jump.line)
    editor.setPosition({ lineNumber: jump.line, column: 1 })
    editor.focus()
  }, [jump, load.status])

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
    }
  }

  const write = async (model: monaco.editor.ITextModel, expectedMtimeMs: number): Promise<void> => {
    const version = model.getAlternativeVersionId()
    const result = await window.kora.writeText(projectId, path, contentOf(model), expectedMtimeMs)
    if (result.ok) {
      setConflict(false)
      markSaved(model, result.mtimeMs, version)
    } else if (result.conflict) {
      setConflict(true)
    } else {
      setNotice(result.message)
    }
  }

  const save = (): Promise<void> =>
    withBusy(async () => {
      const model = editorRef.current?.getModel()
      if (model) await write(model, mtimeRef.current)
    })

  useEffect(() => {
    saveRef.current = save
  })

  // Relê só para pegar o mtime atual; o conteúdo gravado continua sendo o do editor.
  const overwrite = (): Promise<void> =>
    withBusy(async () => {
      const model = editorRef.current?.getModel()
      if (!model) return
      const fresh = await window.kora.readText(projectId, path)
      await write(model, fresh.mtimeMs)
    })

  const reloadFromDisk = (): Promise<void> =>
    withBusy(async () => {
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!editor || !model) return
      const fresh = await window.kora.readText(projectId, path)
      const view = editor.saveViewState()
      model.setValue(fresh.content)
      if (view) editor.restoreViewState(view)
      setConflict(false)
      markSaved(model, fresh.mtimeMs, model.getAlternativeVersionId())
    })

  const onHeaderReload = async (): Promise<void> => {
    if (!editorRef.current) {
      setReloadKey((k) => k + 1)
      return
    }
    if (dirtyRef.current) {
      const discard = await confirm({
        title: 'Recarregar do disco?',
        message: 'As alterações feitas desde o último Ctrl+S serão descartadas.',
        confirmLabel: 'Descartar e recarregar',
        danger: true
      })
      if (!discard) return
    }
    void reloadFromDisk()
  }

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader path={path} onReload={() => void onHeaderReload()}>
        {busy ? (
          <span className="shrink-0">Salvando…</span>
        ) : (
          dirty && (
            <span className="flex shrink-0 items-center gap-1.5 text-amber-300" title="Alterações não salvas (Ctrl+S)">
              <span className="size-1.5 rounded-full bg-current" />
              Não salvo
            </span>
          )
        )}
        <button
          type="button"
          title="Salvar (Ctrl+S)"
          disabled={!dirty || busy || load.status !== 'ready'}
          onClick={() => void save()}
          className="shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-secondary disabled:cursor-default disabled:text-muted-foreground disabled:opacity-60 disabled:hover:bg-transparent"
        >
          Salvar
        </button>
        {headerExtra}
      </ViewerHeader>

      {conflict && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          <Icon name="alerta" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">O arquivo mudou no disco (provavelmente o Claude/Codex editou).</span>
          <button type="button" disabled={busy} onClick={() => void reloadFromDisk()} className={bannerButton}>
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
          <button type="button" title="Fechar aviso" onClick={() => setNotice(null)} className="rounded p-0.5 hover:bg-white/10">
            <Icon name="fechar" className="size-3.5" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} data-file-text className={cn('absolute inset-0', load.status !== 'ready' && 'invisible')} />
        {load.status === 'loading' && <p className="absolute p-4 text-xs text-muted-foreground">Carregando…</p>}
        {load.status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-start gap-3 p-4">
            <p className="text-xs text-destructive">{load.message}</p>
            <button
              type="button"
              onClick={openExternal}
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Abrir no programa padrão
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
