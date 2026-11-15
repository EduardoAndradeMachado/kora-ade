import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { monaco } from '@/lib/monaco'
import { lineAtOffset, lineForTop, offsetForLine, scrollPoints, topForLine, type ScrollPoint } from '@/lib/markdown-scroll'
import { MarkdownView } from '@/components/MarkdownView'

type ViewProps = Omit<ComponentProps<typeof MarkdownView>, 'live' | 'scrollerRef' | 'autoEditEmpty'>

interface Props extends ViewProps {
  // Onde o CodeView desta aba está montado. O editor é achado pelo DOM e não pela URI do model: o mesmo arquivo
  // aberto em duas abas tem dois models, e a URI do segundo ganha uma query.
  editorHost: React.RefObject<HTMLElement | null>
  followScroll: boolean
}

// Reprocessar o Markdown (e o mermaid) a cada tecla trava documento grande.
const LIVE_DELAY_MS = 120

const editorIn = (host: HTMLElement | null): monaco.editor.ICodeEditor | null =>
  (host && monaco.editor.getEditors().find((e) => host.contains(e.getContainerDomNode()))) ?? null

export function LiveMarkdownView({ editorHost, followScroll, ...view }: Props): React.JSX.Element {
  const [editor, setEditor] = useState<monaco.editor.ICodeEditor | null>(null)
  const [text, setText] = useState<string | undefined>(undefined)
  const scrollerRef = useRef<HTMLDivElement>(null)

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
        timer = setTimeout(read, LIVE_DELAY_MS)
      }),
      editor.onDidChangeModel(read),
      editor.onDidDispose(() => setEditor(null))
    ]
    return () => {
      clearTimeout(timer)
      for (const s of subscriptions) s.dispose()
    }
  }, [editor])

  // Nos dois sentidos, bloco a bloco: cada bloco da visualização tem a linha onde começa no texto (data-line), e o
  // meio de um bloco interpola até o próximo. Quem rola é o "dono" da rolagem; a rolagem aplicada no outro lado
  // não volta (sem eco).
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!editor || !followScroll || !scroller) return
    const renderedLines = (text ?? '').split('\n').length
    let points: ScrollPoint[] | null = null
    let leader: 'editor' | 'preview' = 'editor'
    let syncingEditor = false
    let editorScrolledInSync = false
    let expectedEditorTop: number | null = null
    let expectedPreviewTop: number | null = null

    const measure = (): ScrollPoint[] => {
      if (points) return points
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop
      const anchors: ScrollPoint[] = []
      for (const block of scroller.querySelectorAll<HTMLElement>('[data-line]')) {
        // O mermaid esconde o <pre> e põe o desenho logo antes dele.
        const shown = block.hidden && block.previousElementSibling?.matches('.mermaid-diagram') ? block.previousElementSibling : block
        if (shown.getClientRects().length === 0) continue
        anchors.push({ line: Number(block.dataset['line']), top: shown.getBoundingClientRect().top - origin })
      }
      points = scrollPoints(anchors, renderedLines, scroller.scrollHeight)
      return points
    }

    const lineCount = (): number => editor.getModel()?.getLineCount() ?? 0
    const topOf = (n: number): number => editor.getTopForLineNumber(n)
    const editorMax = (): number => editor.getScrollHeight() - editor.getLayoutInfo().height
    const previewMax = (): number => scroller.scrollHeight - scroller.clientHeight

    // No fim de um lado, o fim do outro: o último bloco raramente termina alinhado com a última linha.
    const followEditor = (): void => {
      const top = editor.getScrollTop()
      const max = editorMax()
      scroller.scrollTop = max > 0 && top >= max - 1 ? previewMax() : topForLine(measure(), lineAtOffset(lineCount(), topOf, top))
      expectedPreviewTop = scroller.scrollTop
    }

    const withEditorSync = (task: () => void): void => {
      syncingEditor = true
      editorScrolledInSync = false
      try {
        task()
      } finally {
        syncingEditor = false
      }
      expectedEditorTop = editorScrolledInSync ? null : editor.getScrollTop()
    }

    const followPreview = (): void => {
      const top = scroller.scrollTop
      const max = previewMax()
      const target = max > 0 && top >= max - 1 ? editorMax() : offsetForLine(lineCount(), topOf, lineForTop(measure(), top))
      withEditorSync(() => editor.setScrollTop(target))
    }

    const onEditorScroll = editor.onDidScrollChange((e) => {
      if (!e.scrollTopChanged) return
      if (syncingEditor) {
        editorScrolledInSync = true
        return
      }
      const expected = expectedEditorTop
      expectedEditorTop = null
      if (expected !== null && Math.abs(editor.getScrollTop() - expected) < 1) return
      leader = 'editor'
      followEditor()
    })

    const onPreviewScroll = (): void => {
      const expected = expectedPreviewTop
      expectedPreviewTop = null
      if (expected !== null && Math.abs(scroller.scrollTop - expected) < 1) return
      leader = 'preview'
      followPreview()
    }

    // Diagrama e imagem mudam a altura dos blocos depois de desenhados.
    const resized = new ResizeObserver(() => {
      points = null
      if (leader === 'editor') followEditor()
    })
    resized.observe(scroller)
    for (const child of scroller.children) resized.observe(child)

    // Clique duplo na visualização leva o cursor do editor à linha do texto clicado.
    const onDoubleClick = (e: MouseEvent): void => {
      if ((e.target as Element).closest('a')) return
      const y = e.clientY - scroller.getBoundingClientRect().top + scroller.scrollTop
      const line = Math.min(lineCount(), Math.floor(lineForTop(measure(), y)) + 1)
      if (line < 1) return
      withEditorSync(() => {
        editor.setPosition({ lineNumber: line, column: 1 })
        editor.revealLineInCenterIfOutsideViewport(line)
      })
      editor.focus()
    }

    followEditor()
    scroller.addEventListener('scroll', onPreviewScroll, { passive: true })
    scroller.addEventListener('dblclick', onDoubleClick)
    return () => {
      onEditorScroll.dispose()
      resized.disconnect()
      scroller.removeEventListener('scroll', onPreviewScroll)
      scroller.removeEventListener('dblclick', onDoubleClick)
    }
  }, [editor, followScroll, text])

  return <MarkdownView {...view} live={text} scrollerRef={scrollerRef} />
}
