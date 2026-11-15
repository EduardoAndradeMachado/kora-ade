import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/brand/icons'
import { EDITOR_OPTIONS, languageForPath, languageLabel, monaco, themeForDocument } from '@/lib/monaco'
import { ipcErrorMessage, isNotFound } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { acquireProjectNavigation, claimModelUri, registerEditorHost, releaseModelUri, takeJumpColumn } from '@/lib/code-nav'
import { touchesFile } from '@shared/file-change'
import type { FilesChange, TextFile } from '@shared/ipc'
import { TEXT_ENCODINGS } from '@shared/text-encodings'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'
import { useConfirm } from '@/components/ConfirmDialog'
import { headerButton, ViewerHeader } from '@/components/ViewerHeader'
import { trackExternalReloads, type ExternalReloads } from '@/lib/external-reloads'
import { BannerSlot } from '@/lib/banner-slot'
import { editorLanguage } from '@/lib/memory-languages'
import { ensureRoom } from '@/lib/memory-budget'
import { tightMessage } from '@/lib/memory-tabs'
import { estimatedCost } from '@shared/open-limits'

interface Props {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  fontSize: number
  wordWrap: boolean
  onWordWrapChange(on: boolean): void
  onDirtyChange(dirty: boolean): void
  headerExtra?: React.ReactNode
  // Deixa quem fecha a aba salvar antes; o salvamento pode não acontecer (conflito, erro) e aí devolve false.
  onSaveHandle?(save: (() => Promise<boolean>) | null): void
  // column/length: o trecho a selecionar (resultado da busca), como o VS Code faz ao abrir uma ocorrência.
  jump?: { line: number; n: number; column?: number; length?: number }
  // Último pedido de abrir a aba; focus false não tira o foco de onde ele está (ver file-tabs.ts).
  focusRequest?: { n: number; focus: boolean }
  onOpenPath(rel: string, line: number | null): void
}

type Load = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }

type Eol = 'LF' | 'CRLF'

interface Info {
  language: string
  encoding?: string
  eol: Eol
}

type Menu = { x: number; y: number; items: MenuItem[]; key: number }

interface Cursor {
  line: number
  column: number
  // Caracteres selecionados na seleção principal; com vários cursores, quantas seleções há.
  selected: number
  selections: number
}

// Como a barra de status do VS Code: "Ln 12, Col 5 (3 selecionados)", ou "4 seleções" com vários cursores.
const cursorLabel = ({ line, column, selected, selections }: Cursor): string => {
  const position = `Ln ${line}, Col ${column}`
  if (selections > 1) return `${position} (${selections} seleções)`
  return selected > 0 ? `${position} (${selected} ${selected === 1 ? 'selecionado' : 'selecionados'})` : position
}

// Linguagens do worker do TypeScript, o único que navega entre arquivos (F12, Shift+F12).
const NAV_LANGUAGES = new Set(['typescript', 'javascript'])

const encodingLabel = (id: string | undefined): string | undefined => TEXT_ENCODINGS.find((e) => e.id === id)?.label

// O Monaco normaliza o texto para um fim de linha só ao abrir; é esse que vai para o disco.
const eolOf = (model: monaco.editor.ITextModel): Eol => (model.getEOL() === '\r\n' ? 'CRLF' : 'LF')

// O getValue padrão descarta o BOM: salvar sem mudar nada reescreveria o arquivo sem ele.
const contentOf = (model: monaco.editor.ITextModel): string =>
  model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true)

// "Salvar com codificação" troca o BOM no disco sem trocar o do model: o BOM não conta como mudança de conteúdo.
const sameText = (a: string, b: string): boolean => a.replace(/^﻿/, '') === b.replace(/^﻿/, '')

const normalizeRel = (rel: string): string => rel.replace(/\//g, '\\').toLowerCase()

// Pasta renomeada ou apagada chega do watcher como o nome da pasta, não como os arquivos de dentro.
const touchesAncestor = (change: FilesChange, rel: string): boolean => {
  const target = normalizeRel(rel)
  return change.files.some((f) => target.startsWith(normalizeRel(f) + '\\'))
}

// Depois de aberto, o arquivo continua no editor mesmo que cresça além do limite normal de abertura.
const OPEN_ALREADY = { force: true }

const bannerButton = 'rounded-md border border-current/30 px-2 py-0.5 hover:bg-white/10 disabled:opacity-50'
const infoButton = 'rounded px-1 hover:bg-secondary hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-current'

export function CodeView({
  projectId,
  projectPath,
  path,
  visible,
  fontSize,
  wordWrap,
  onWordWrapChange,
  onDirtyChange,
  headerExtra,
  onSaveHandle,
  jump,
  focusRequest,
  onOpenPath
}: Props): React.JSX.Element {
  const confirm = useConfirm()
  const hostRef = useRef<HTMLDivElement>(null)
  const diffHostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const diffRef = useRef<{ editor: monaco.editor.IStandaloneDiffEditor; original: monaco.editor.ITextModel } | null>(null)
  const mtimeRef = useRef(0)
  const encodingIdRef = useRef<string | undefined>(undefined)
  // A codificação veio de "Reabrir/Salvar com codificação": vale para reler e gravar, em vez da detecção.
  const chosenEncodingRef = useRef(false)
  const savedVersionRef = useRef(0)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const forceOpenRef = useRef(false)
  const onDirtyRef = useRef(onDirtyChange)
  const onOpenPathRef = useRef(onOpenPath)
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const fontSizeRef = useRef(fontSize)
  const wordWrapRef = useRef(wordWrap)
  const toggleWrapRef = useRef(() => {})
  const checkDiskRef = useRef<() => Promise<void>>(async () => {})
  const checkAfterBusyRef = useRef(false)
  const reloadsRef = useRef<ExternalReloads | null>(null)
  const bannerSlot = useContext(BannerSlot)

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [info, setInfo] = useState<Info | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  // O texto do editor vem de antes da última mudança feita fora (Ctrl+Z passou por ela).
  const [beforeReload, setBeforeReload] = useState(false)
  const [cursor, setCursor] = useState<Cursor | null>(null)
  const menuKeyRef = useRef(0)
  const closeMenu = useCallback(() => setMenu(null), [])

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

  const showFileInfo = (file: TextFile, model: monaco.editor.ITextModel): void => {
    encodingIdRef.current = file.encodingId
    setInfo({ language: languageLabel(model.getLanguageId()), encoding: file.encoding, eol: eolOf(model) })
  }

  // Releitura do mesmo arquivo: com codificação escolhida pelo usuário, decodifica nela de novo.
  const rereadOptions = (): { force: boolean; encoding?: string } =>
    chosenEncodingRef.current ? { force: true, encoding: encodingIdRef.current } : OPEN_ALREADY

  // O diff só empresta o model do editor como lado modificado: fechar não perde nem desfaz a edição.
  const disposeCompare = (): void => {
    const diff = diffRef.current
    diffRef.current = null
    diff?.editor.dispose()
    diff?.original.dispose()
  }

  const closeCompare = (): void => {
    if (!diffRef.current) return
    disposeCompare()
    setComparing(false)
    editorRef.current?.focus()
  }

  useEffect(() => {
    forceOpenRef.current = false
    chosenEncodingRef.current = false
  }, [projectId, path])

  useEffect(() => {
    onOpenPathRef.current = onOpenPath
  }, [onOpenPath])

  useEffect(() => {
    let cancelled = false
    let editor: monaco.editor.IStandaloneCodeEditor | undefined
    let model: monaco.editor.ITextModel | undefined
    let releaseNavigation: (() => void) | undefined
    let host: monaco.IDisposable | undefined
    setLoad({ status: 'loading' })
    setConflict(false)
    setDeleted(false)
    setComparing(false)
    setNotice(null)
    setInfo(null)
    setMenu(null)
    setBeforeReload(false)
    setCursor(null)

    const encoding = chosenEncodingRef.current ? encodingIdRef.current : undefined
    window.kora.readText(projectId, path, { force: forceOpenRef.current, encoding }).then(
      (file) => {
        if (cancelled || !hostRef.current) return
        model = monaco.editor.createModel(file.content, editorLanguage(path, file.content.length, languageForPath(path)), claimModelUri(projectId, path))
        editor = monaco.editor.create(hostRef.current, {
          ...EDITOR_OPTIONS,
          fontSize: fontSizeRef.current,
          wordWrap: wordWrapRef.current ? 'on' : 'off',
          theme: themeForDocument(),
          model
        })
        editorRef.current = editor
        const loaded = model
        const reloads = trackExternalReloads(loaded)
        reloadsRef.current = reloads
        markSaved(loaded, file.mtimeMs, loaded.getAlternativeVersionId())
        showFileInfo(file, loaded)
        loaded.onDidChangeContent(() => {
          refreshDirty(loaded)
          setBeforeReload(reloads.isBeforeReload())
        })
        const created = editor
        const showCursor = (): void => {
          const selections = created.getSelections() ?? []
          const primary = selections[0]
          if (!primary) return
          setCursor({
            line: primary.positionLineNumber,
            column: primary.positionColumn,
            selected: loaded.getValueLengthInRange(primary),
            selections: selections.length
          })
        }
        created.onDidChangeCursorSelection(showCursor)
        showCursor()
        loaded.onDidChangeContent((e) => {
          if (e.isEolChange) setInfo((i) => i && { ...i, eol: eolOf(loaded) })
        })
        if (NAV_LANGUAGES.has(loaded.getLanguageId())) {
          releaseNavigation = acquireProjectNavigation(projectId, path)
          host = registerEditorHost(editor, { projectId, open: (rel, line) => onOpenPathRef.current(rel, line) })
        }
        // addAction em vez de addCommand: o atalho de addCommand vale para o último editor
        // criado, não para o que tem foco, e salvaria o arquivo de outra aba.
        editor.addAction({
          id: 'kora.save',
          label: 'Salvar',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => void saveRef.current()
        })
        editor.addAction({
          id: 'kora.wordWrap',
          label: 'Quebra de linha',
          keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
          run: () => toggleWrapRef.current()
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
      reloadsRef.current?.dispose()
      reloadsRef.current = null
      disposeCompare()
      host?.dispose()
      releaseNavigation?.()
      editor?.dispose()
      if (model) releaseModelUri(model.uri)
      model?.dispose()
      publishDirty(false)
    }
  }, [projectId, path, reloadKey])

  useEffect(() => {
    fontSizeRef.current = fontSize
    editorRef.current?.updateOptions({ fontSize })
    diffRef.current?.editor.updateOptions({ fontSize })
  }, [fontSize])

  useEffect(() => {
    wordWrapRef.current = wordWrap
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
    diffRef.current?.editor.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
  }, [wordWrap])

  useEffect(() => {
    toggleWrapRef.current = () => onWordWrapChange(!wordWrap)
  })

  useEffect(
    () =>
      window.kora.onFilesChanged((changedProject, change) => {
        if (changedProject !== projectId) return
        if (touchesFile(change, path) || touchesAncestor(change, path)) void checkDiskRef.current()
      }),
    [projectId, path]
  )

  // Aberto por clique simples na árvore ou na busca (focus false) com o foco ainda lá: fica lá, como no VS Code.
  // Foco que já saiu da lista (ex.: o botão Editar do Markdown montou este editor depois) vem para o editor.
  const keepsFocusElsewhere = (): boolean =>
    focusRequest?.focus === false && document.activeElement instanceof Element && document.activeElement.closest('[data-keeps-focus]') !== null
  // Só o pedido novo é pulado; voltar à aba depois foca o editor de novo.
  const focusSeen = useRef(0)
  useEffect(() => {
    if (!visible || load.status !== 'ready') return
    const fresh = focusRequest !== undefined && focusRequest.n !== focusSeen.current
    if (focusRequest) focusSeen.current = focusRequest.n
    if (fresh && keepsFocusElsewhere()) return
    editorRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, load.status, focusRequest?.n])

  useEffect(() => {
    const editor = editorRef.current
    if (!jump || load.status !== 'ready' || !editor) return
    const navColumn = takeJumpColumn(projectId, path, jump.line)
    if (jump.column !== undefined && jump.length !== undefined && jump.length > 0) {
      // Da esquerda para a direita: o cursor fica no fim do trecho, como no VS Code.
      const range = new monaco.Range(jump.line, jump.column, jump.line, jump.column + jump.length)
      editor.setSelection(range)
      editor.revealRangeInCenter(range)
    } else {
      editor.revealLineInCenter(jump.line)
      editor.setPosition({ lineNumber: jump.line, column: jump.column ?? navColumn ?? 1 })
    }
    if (!keepsFocusElsewhere()) editor.focus()
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
      if (checkAfterBusyRef.current) {
        checkAfterBusyRef.current = false
        void checkDiskRef.current()
      }
    }
  }

  // Arquivo apagado ou movido: o main recria ao salvar, sem checar o mtime antigo.
  const write = async (model: monaco.editor.ITextModel, expectedMtimeMs: number): Promise<boolean> => {
    const version = model.getAlternativeVersionId()
    const result = await window.kora.writeText(projectId, path, contentOf(model), expectedMtimeMs, encodingIdRef.current, {
      forceEncoding: chosenEncodingRef.current
    })
    if (result.ok) {
      setConflict(false)
      setDeleted(false)
      closeCompare()
      reloadsRef.current?.saved()
      setBeforeReload(reloadsRef.current?.isBeforeReload() ?? false)
      markSaved(model, result.mtimeMs, version)
    } else if (result.conflict) {
      setConflict(true)
    } else {
      setNotice(result.message)
    }
    return result.ok
  }

  // Como o "Save with Encoding" do VS Code: grava agora, mesmo sem alteração, e a codificação fica para os próximos
  // Ctrl+S. Se não gravar (caractere que não cabe, conflito), a codificação anterior continua valendo.
  const saveWithEncoding = (id: string): Promise<void> =>
    withBusy(async () => {
      const model = editorRef.current?.getModel()
      if (!model) return
      const previous = { id: encodingIdRef.current, chosen: chosenEncodingRef.current }
      encodingIdRef.current = id
      chosenEncodingRef.current = true
      if (await write(model, mtimeRef.current)) {
        setInfo((i) => i && { ...i, encoding: encodingLabel(id) })
      } else {
        encodingIdRef.current = previous.id
        chosenEncodingRef.current = previous.chosen
      }
    })

  // Ctrl+S com o texto de antes da mudança de fora apagaria o trabalho do agente: só com confirmação.
  const save = async (): Promise<void> => {
    if (busyRef.current) return
    if (reloadsRef.current?.isBeforeReload() && dirtyRef.current) {
      const overwrite = await confirm({
        title: 'Sobrescrever a mudança feita fora do editor?',
        message:
          'Você desfez uma mudança feita fora do editor (por um agente ou outro programa). Salvar grava o texto de antes por cima do que está no disco.',
        confirmLabel: 'Salvar por cima',
        danger: true
      })
      if (!overwrite) return
    }
    return withBusy(async () => {
      const model = editorRef.current?.getModel()
      if (model) await write(model, mtimeRef.current)
    })
  }

  useEffect(() => {
    saveRef.current = save
  })

  // Relê só para pegar o mtime atual; o conteúdo gravado continua sendo o do editor.
  const overwrite = (): Promise<void> =>
    withBusy(async () => {
      const model = editorRef.current?.getModel()
      if (!model) return
      const fresh = await window.kora.readText(projectId, path, rereadOptions())
      await write(model, fresh.mtimeMs)
    })

  // encoding: "Reabrir com codificação". Se a leitura falhar (UTF-16 com tamanho ímpar), nada muda no editor.
  const reloadFromDisk = (encoding?: string): Promise<void> =>
    withBusy(async () => {
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!editor || !model) return
      const fresh = await window.kora.readText(projectId, path, encoding ? { force: true, encoding } : rereadOptions())
      if (editorRef.current !== editor) return
      if (encoding) chosenEncodingRef.current = true
      closeCompare()
      const view = editor.saveViewState()
      model.setValue(fresh.content)
      if (view) editor.restoreViewState(view)
      setConflict(false)
      setDeleted(false)
      showFileInfo(fresh, model)
      markSaved(model, fresh.mtimeMs, model.getAlternativeVersionId())
    })

  // Disco à esquerda, a versão do editor à direita (editável, com Ctrl+S). Estreito, o Monaco junta os dois lados.
  const openCompare = async (): Promise<void> => {
    const model = editorRef.current?.getModel()
    const host = diffHostRef.current
    if (!model || !host || diffRef.current) return
    setNotice(null)
    let fresh: TextFile
    try {
      fresh = await window.kora.readText(projectId, path, rereadOptions())
    } catch (err) {
      setNotice(ipcErrorMessage(err))
      return
    }
    if (editorRef.current?.getModel() !== model || diffRef.current) return
    const original = monaco.editor.createModel(fresh.content, model.getLanguageId())
    const editor = monaco.editor.createDiffEditor(host, {
      ...EDITOR_OPTIONS,
      fontSize: fontSizeRef.current,
      wordWrap: wordWrapRef.current ? 'on' : 'off',
      theme: themeForDocument(),
      originalEditable: false
    })
    editor.setModel({ original, modified: model })
    editor.getModifiedEditor().addAction({
      id: 'kora.save',
      label: 'Salvar',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => void saveRef.current()
    })
    diffRef.current = { editor, original }
    setComparing(true)
    editor.getModifiedEditor().focus()
  }

  // Chamado pelo watcher, que também avisa as gravações do próprio Kora: só o mtime diferente do último
  // lido ou salvo conta como mudança de fora. Com um salvamento em andamento o mtime ainda é o antigo;
  // confere de novo quando ele acabar.
  const checkDisk = async (): Promise<void> => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    if (busyRef.current) {
      checkAfterBusyRef.current = true
      return
    }
    const known = mtimeRef.current
    // Outro erro de leitura (arquivo preso por outro programa no meio de uma gravação) não diz nada: a próxima
    // mudança confere de novo.
    const fresh = await window.kora.readText(projectId, path, rereadOptions()).catch((err: unknown) => (isNotFound(err) ? 'missing' : null))
    if (!fresh || editorRef.current !== editor) return
    if (busyRef.current) {
      checkAfterBusyRef.current = true
      return
    }
    if (fresh === 'missing') return setDeleted(true)
    setDeleted(false)
    if (mtimeRef.current !== known) return void checkDiskRef.current()
    if (fresh.mtimeMs === known) return
    showFileInfo(fresh, model)
    if (sameText(fresh.content, contentOf(model))) {
      markSaved(model, fresh.mtimeMs, model.getAlternativeVersionId())
      setConflict(false)
      closeCompare()
    } else if (dirtyRef.current) {
      diffRef.current?.original.setValue(fresh.content)
      setConflict(true)
    } else {
      // Edição em vez de setValue: o Ctrl+Z volta para o que estava antes da mudança de fora, com aviso.
      const view = editor.saveViewState()
      reloadsRef.current?.apply(fresh.content.replace(/^﻿/, ''))
      if (view) editor.restoreViewState(view)
      markSaved(model, fresh.mtimeMs, model.getAlternativeVersionId())
      setConflict(false)
      closeCompare()
    }
  }

  useEffect(() => {
    checkDiskRef.current = checkDisk
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

  const reopenWithEncoding = async (id: string): Promise<void> => {
    if (dirtyRef.current) {
      const discard = await confirm({
        title: 'Reabrir com outra codificação?',
        message: 'As alterações feitas desde o último Ctrl+S serão descartadas.',
        confirmLabel: 'Descartar e reabrir',
        danger: true
      })
      if (!discard) return
    }
    void reloadFromDisk(id)
  }

  // Como o "Change End of Line Sequence" do VS Code: converte o arquivo todo, entra no desfazer e marca como alterado.
  const changeEol = (eol: Eol): void => {
    const model = editorRef.current?.getModel()
    if (!model || eolOf(model) === eol) return
    model.pushStackElement()
    model.pushEOL(eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
    model.pushStackElement()
    editorRef.current?.focus()
  }

  // Chave nova a cada menu: o segundo nível abre no mesmo ponto e precisa medir de novo o espaço até a borda.
  const openMenu = (anchor: HTMLElement, items: MenuItem[]): void => {
    const rect = anchor.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 4, items, key: ++menuKeyRef.current })
  }

  const encodingList = (anchor: HTMLElement, onPick: (id: string) => void): void =>
    openMenu(
      anchor,
      TEXT_ENCODINGS.map((e) => ({
        label: 'detail' in e ? `${e.label} (${e.detail})` : e.label,
        icon: e.id === encodingIdRef.current ? <Icon name="ok" /> : undefined,
        onSelect: () => onPick(e.id)
      }))
    )

  // Como no VS Code, a codificação abre primeiro a escolha entre reabrir e salvar, e depois a lista.
  const openEncodingMenu = (anchor: HTMLElement): void =>
    openMenu(anchor, [
      { label: 'Reabrir com codificação…', onSelect: () => encodingList(anchor, (id) => void reopenWithEncoding(id)) },
      { label: 'Salvar com codificação…', onSelect: () => encodingList(anchor, (id) => void saveWithEncoding(id)) }
    ])

  const openEolMenu = (anchor: HTMLElement): void =>
    openMenu(
      anchor,
      (['LF', 'CRLF'] as const).map((eol) => ({
        label: eol,
        icon: info?.eol === eol ? <Icon name="ok" /> : undefined,
        onSelect: () => changeEol(eol)
      }))
    )

  const openExternal = (): void => {
    window.kora.openFile(projectId, path).catch((err: unknown) => setNotice(ipcErrorMessage(err)))
  }

  const openAnyway = async (): Promise<void> => {
    const [bytes] = await window.kora.memoryFileSizes(projectId, [path]).catch(() => [0])
    const room = await ensureRoom(estimatedCost('text', bytes ?? 0))
    if (room.status === 'tight' && !(await confirm({ title: 'Abrir mesmo assim?', message: tightMessage(room.usedMB), confirmLabel: 'Abrir mesmo assim', danger: true }))) return
    forceOpenRef.current = true
    setReloadKey((k) => k + 1)
  }

  const tooLarge = load.status === 'error' && load.message.startsWith('Arquivo grande demais')
  const editable = load.status === 'ready' && !busy

  // Em Visualizar do Markdown o editor está escondido: comparar precisa dele à vista.
  const compare = (): void => {
    bannerSlot?.reveal()
    void openCompare()
  }

  const goToLine = (): void => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    void editor.getAction('editor.action.gotoLine')?.run()
  }

  const compareButton = (
    <button type="button" disabled={busy} onClick={() => (comparing ? closeCompare() : compare())} className={bannerButton}>
      {comparing ? 'Voltar ao editor' : 'Comparar'}
    </button>
  )

  const banners = (
    <>
      {deleted && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          <Icon name="alerta" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Este arquivo foi apagado ou movido no disco. Salvar recria o arquivo.</span>
        </div>
      )}

      {conflict && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          <Icon name="alerta" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {comparing
              ? 'À esquerda, a versão do disco; à direita, a sua, que continua editável.'
              : 'O arquivo mudou no disco enquanto você editava. Recarregar descarta as suas alterações; Sobrescrever grava a sua versão por cima.'}
          </span>
          {compareButton}
          <button type="button" disabled={busy} onClick={() => void reloadFromDisk()} className={bannerButton}>
            Recarregar do disco
          </button>
          <button type="button" disabled={busy} onClick={() => void overwrite()} className={bannerButton}>
            Sobrescrever
          </button>
        </div>
      )}

      {beforeReload && dirty && !conflict && (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300">
          <Icon name="alerta" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {comparing
              ? 'À esquerda, o que está no disco; à direita, o texto do editor, de antes da mudança feita fora.'
              : 'Você desfez uma mudança feita fora do editor (por um agente ou outro programa). Salvar vai sobrescrever o que está no disco.'}
          </span>
          {compareButton}
          <button type="button" disabled={busy} onClick={() => void reloadFromDisk()} className={bannerButton}>
            Recarregar do disco
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
    </>
  )

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={() => void onHeaderReload()}>
        {cursor && (
          // Uma faixa acima da linguagem: com o cabeçalho apertando, some antes dela.
          <button
            type="button"
            data-tip="Ir para linha/coluna"
            data-tip-shortcut="Ctrl+G"
            disabled={load.status !== 'ready'}
            onClick={goToLine}
            className={cn(infoButton, 'hidden shrink-0 whitespace-nowrap @3xl:inline')}
          >
            {cursorLabel(cursor)}
          </button>
        )}
        {info && (
          <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap @2xl:flex">
            <span data-tip="Linguagem">{info.language}</span>
            {info.encoding && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  data-tip="Selecionar codificação"
                  aria-haspopup="menu"
                  disabled={!editable}
                  onClick={(e) => openEncodingMenu(e.currentTarget)}
                  className={infoButton}
                >
                  {info.encoding}
                </button>
              </>
            )}
            <span aria-hidden="true">·</span>
            <button
              type="button"
              data-tip="Selecionar fim de linha"
              aria-haspopup="menu"
              disabled={!editable}
              onClick={(e) => openEolMenu(e.currentTarget)}
              className={infoButton}
            >
              {info.eol}
            </button>
          </span>
        )}
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
          data-tip={wordWrap ? 'Quebra de linha ligada' : 'Quebra de linha desligada'}
          data-tip-shortcut="Alt+Z"
          aria-label={wordWrap ? 'Quebra de linha ligada (Alt+Z)' : 'Quebra de linha desligada (Alt+Z)'}
          aria-pressed={wordWrap}
          onClick={() => onWordWrapChange(!wordWrap)}
          className={cn(headerButton, 'shrink-0', wordWrap && 'bg-secondary text-foreground')}
        >
          <Icon name="quebraLinha" active={wordWrap} className="size-3.5" />
        </button>
        <button
          type="button"
          data-tip="Salvar" data-tip-shortcut="Ctrl+S"
          disabled={(!dirty && !deleted) || busy || load.status !== 'ready'}
          onClick={() => void save()}
          className="shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-secondary disabled:cursor-default disabled:text-muted-foreground disabled:opacity-60 disabled:hover:bg-transparent"
        >
          Salvar
        </button>
        {headerExtra}
      </ViewerHeader>

      {bannerSlot?.slot ? createPortal(banners, bannerSlot.slot) : banners}

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} data-file-text className={cn('absolute inset-0', (load.status !== 'ready' || comparing) && 'invisible')} />
        <div ref={diffHostRef} data-file-text className={cn('absolute inset-0', !comparing && 'invisible')} />
        {load.status === 'loading' && <p className="absolute p-4 text-xs text-muted-foreground">Carregando…</p>}
        {load.status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-start gap-3 p-4">
            <p className="text-xs text-destructive">{load.message}</p>
            <div className="flex flex-wrap gap-2">
              {tooLarge && (
                <button
                  type="button"
                  onClick={() => void openAnyway()}
                  className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  Abrir mesmo assim
                </button>
              )}
              <button
                type="button"
                onClick={openExternal}
                className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                Abrir no programa padrão
              </button>
            </div>
          </div>
        )}
      </div>

      {menu && <ContextMenu key={menu.key} x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  )
}
