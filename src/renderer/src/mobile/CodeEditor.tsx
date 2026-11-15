import { useEffect, useRef, type MutableRefObject } from 'react'
import { basicSetup } from 'codemirror'
import { Annotation, Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, highlightActiveLineGutter, highlightSpecialChars, lineNumbers, type DecorationSet } from '@codemirror/view'
import { bracketMatching, defaultHighlightStyle, foldGutter, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'

const surface = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--card)' },
  '.cm-scroller': { fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace", lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: 'var(--card)', borderRight: '1px solid var(--border)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-jump-line': { backgroundColor: 'color-mix(in oklab, var(--brand-amber) 22%, transparent)' }
})

// Leitura sem o desenho de seleção do CodeMirror (drawSelection, no basicSetup): ele esconde a seleção nativa, e é a
// nativa que dá ao WebView do Android as alças e o menu Copiar do toque longo. Sem contenteditable, o teclado não abre.
const reading = [lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), foldGutter(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), EditorView.editable.of(false), EditorState.readOnly.of(true)]

const jumpTo = StateEffect.define<number | null>()
const fromPc = Annotation.define<boolean>()
const JUMP_MS = 4000
const jumpLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(jumpTo)) continue
      if (effect.value === null) return Decoration.none
      return Decoration.set([Decoration.line({ class: 'cm-jump-line' }).range(tr.state.doc.line(effect.value).from)])
    }
    return tr.docChanged ? Decoration.none : value.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})

export interface CodeEditorHandle {
  // O trecho selecionado (vazio sem seleção) e o texto inteiro, para o Copiar do cabeçalho.
  selected(): string
  all(): string
}

// CodeMirror e não o Monaco do PC: o Monaco não funciona com o toque e o teclado do celular. O editor nasce uma vez
// por arquivo; o texto do PC que chega depois (revision muda: recarregou, o agente gravou) troca o conteúdo no lugar,
// sem entrar no desfazer e sem perder a rolagem. O digitado sai por onChange.
export function CodeEditor({ path, text, revision, dark, editable, line, handle, onChange }: { path: string; text: string; revision: number; dark: boolean; editable: boolean; line: number | null; handle?: MutableRefObject<CodeEditorHandle | null>; onChange(text: string): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const initial = useRef({ text, editable }).current
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const view = useRef<EditorView | null>(null)
  const theme = useRef(new Compartment())
  const mode = useRef(new Compartment())
  useEffect(() => {
    const language = new Compartment()
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial.text,
        extensions: [
          mode.current.of(initial.editable ? basicSetup : reading),
          EditorView.lineWrapping,
          // Arquivo com fim de linha do Windows volta igual para o disco; senão o git mostraria todas as linhas mudadas.
          EditorState.lineSeparator.of(initial.text.includes('\r\n') ? '\r\n' : '\n'),
          surface,
          jumpLine,
          theme.current.of(dark ? oneDark : []),
          language.of([]),
          // sliceDoc usa o separador acima; doc.toString() juntaria sempre com \n.
          EditorView.updateListener.of((update) => {
            if (update.docChanged && update.transactions.some((tr) => tr.docChanged && !tr.annotation(fromPc))) onChangeRef.current(update.state.sliceDoc())
          })
        ]
      })
    })
    view.current = editor
    if (handle) handle.current = {
      selected: () => editor.state.selection.ranges.map((range) => editor.state.sliceDoc(range.from, range.to)).filter(Boolean).join('\n') || (window.getSelection()?.toString() ?? ''),
      all: () => editor.state.sliceDoc()
    }
    const description = LanguageDescription.matchFilename(languages, path.split(/[\\/]/).pop() ?? path)
    void description?.load().then((support) => editor.dispatch({ effects: language.reconfigure(support) }), () => {})
    return () => {
      editor.destroy()
      view.current = null
      if (handle) handle.current = null
    }
    // O tema e o modo mudam à parte: recriar o editor jogaria fora o que já foi digitado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  useEffect(() => { view.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) }) }, [dark])
  useEffect(() => { view.current?.dispatch({ effects: mode.current.reconfigure(editable ? basicSetup : reading) }) }, [editable])
  const synced = useRef(revision)
  useEffect(() => {
    const editor = view.current
    if (!editor || synced.current === revision) return
    synced.current = revision
    if (editor.state.sliceDoc() === text) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, annotations: [Transaction.addToHistory.of(false), fromPc.of(true)] })
  }, [revision, text])
  useEffect(() => {
    const editor = view.current
    if (!editor || line === null) return
    const target = Math.min(Math.max(1, line), editor.state.doc.lines)
    const at = editor.state.doc.line(target).from
    editor.dispatch({ selection: { anchor: at }, effects: [jumpTo.of(target), EditorView.scrollIntoView(at, { y: 'center' })] })
    const timer = setTimeout(() => view.current?.dispatch({ effects: jumpTo.of(null) }), JUMP_MS)
    return () => clearTimeout(timer)
  }, [line])
  return <div className={`code-editor ${editable ? 'editing' : 'reading'}`} ref={host} />
}
