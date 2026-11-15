import { useEffect, useState, type ComponentProps } from 'react'
import { monaco } from '@/lib/monaco'
import { SpreadsheetView } from '@/components/SpreadsheetView'

type ViewProps = Omit<ComponentProps<typeof SpreadsheetView>, 'live'>

interface Props extends ViewProps {
  // Onde o CodeView desta aba está montado. O editor é achado pelo DOM e não pela URI do model: o mesmo arquivo
  // aberto em duas abas tem dois models, e a URI do segundo ganha uma query.
  editorHost: React.RefObject<HTMLElement | null>
}

// Reinterpretar um CSV de dezenas de MB leva centenas de ms: quanto maior o texto, mais espera depois da última tecla.
const delayFor = (length: number): number => (length > 5_000_000 ? 800 : length > 500_000 ? 300 : 120)

const editorIn = (host: HTMLElement | null): monaco.editor.ICodeEditor | null =>
  (host && monaco.editor.getEditors().find((e) => host.contains(e.getContainerDomNode()))) ?? null

export function LiveSheetView({ editorHost, ...view }: Props): React.JSX.Element {
  const [editor, setEditor] = useState<monaco.editor.ICodeEditor | null>(null)
  const [text, setText] = useState<string | undefined>(undefined)

  // O CodeView cria o editor depois de ler o arquivo e cria outro ao recarregar.
  useEffect(() => {
    let alive = true
    const pick = (): void => {
      if (alive) setEditor(editorIn(editorHost.current))
    }
    pick()
    const created = monaco.editor.onDidCreateEditor(() => queueMicrotask(pick))
    return () => {
      alive = false
      created.dispose()
    }
  }, [editorHost])

  useEffect(() => {
    if (!editor) {
      setText(undefined)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => setText(editor.getModel()?.getValue())
    read()
    const subscriptions = [
      editor.onDidChangeModelContent(() => {
        clearTimeout(timer)
        timer = setTimeout(read, delayFor(editor.getModel()?.getValueLength() ?? 0))
      }),
      editor.onDidChangeModel(read),
      editor.onDidDispose(() => setEditor(null))
    ]
    return () => {
      clearTimeout(timer)
      for (const s of subscriptions) s.dispose()
    }
  }, [editor])

  return <SpreadsheetView {...view} live={text} />
}
