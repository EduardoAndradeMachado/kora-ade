import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'

const surface = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--card)' },
  '.cm-scroller': { fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace", lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: 'var(--card)', borderRight: '1px solid var(--border)' },
  '&.cm-focused': { outline: 'none' }
})

// CodeMirror e não o Monaco do PC: o Monaco não funciona com o toque e o teclado do celular. O texto só é lido ao
// montar (quem usa remonta pela key ao recarregar o arquivo); dali em diante o digitado sai por onChange.
export function CodeEditor({ path, text, dark, onChange }: { path: string; text: string; dark: boolean; onChange(text: string): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const initial = useRef(text).current
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const view = useRef<EditorView | null>(null)
  const theme = useRef(new Compartment())
  useEffect(() => {
    const language = new Compartment()
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          // Arquivo com fim de linha do Windows volta igual para o disco; senão o git mostraria todas as linhas mudadas.
          EditorState.lineSeparator.of(initial.includes('\r\n') ? '\r\n' : '\n'),
          surface,
          theme.current.of(dark ? oneDark : []),
          language.of([]),
          // sliceDoc usa o separador acima; doc.toString() juntaria sempre com \n.
          EditorView.updateListener.of((update) => { if (update.docChanged) onChangeRef.current(update.state.sliceDoc()) })
        ]
      })
    })
    view.current = editor
    const description = LanguageDescription.matchFilename(languages, path.split(/[\\/]/).pop() ?? path)
    void description?.load().then((support) => editor.dispatch({ effects: language.reconfigure(support) }), () => {})
    return () => {
      editor.destroy()
      view.current = null
    }
    // O tema muda à parte: recriar o editor jogaria fora o que já foi digitado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  useEffect(() => { view.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) }) }, [dark])
  return <div className="code-editor" ref={host} />
}
