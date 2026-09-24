import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { meaningfulTitle } from '@shared/terminal-title'
import { terminalBus } from '@/lib/terminal-bus'
import { currentTerminalLook, onThemeChange } from '@/lib/terminal-theme'
import { TERMINAL_FONT } from '@shared/state'
import { cn } from '@/lib/utils'
import { FILE_MIME } from '@/lib/drag'
import { findPathCandidates } from '@shared/terminal-links'

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// Só em dev: permite inspecionar o buffer dos terminais pelo DevTools/CDP, já que o WebGL desenha em canvas.
const devTerminals = new Map<string, Terminal>()
if (import.meta.env.DEV) {
  Object.assign(window, {
    __koraTerminals: devTerminals,
    __koraScreen: (id?: string): string => {
      const term = id ? devTerminals.get(id) : [...devTerminals.values()].at(-1)
      if (!term) return ''
      const buf = term.buffer.active
      const lines: string[] = []
      for (let y = 0; y < term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
      return lines.join('\n')
    },
    __koraType: (data: string, id?: string): void => {
      const key = id ?? [...devTerminals.keys()].at(-1)
      if (key) window.kora.writeTerminal(key, data)
    }
  })
}

const WEBGL_RELEASE_MS = 10_000
// Arquivo pode surgir enquanto o terminal roda (o agente acabou de criar): a resposta "não existe" não dura muito.
const LINK_CACHE_MS = 5_000
const READY_FALLBACK_MS = 500

interface Props {
  id: string
  visible: boolean
  onTitle(title: string): void
  // Chamado uma vez com o tamanho real medido: o pty precisa nascer nele, senão o Claude/Codex
  // desenham a tela inicial num tamanho e o resize logo depois embaralha o conteúdo.
  onReady(cols: number, rows: number): void
  fontSize: number
  projectId: string
  onOpenPath(rel: string, line: number | null): void
}

export function TerminalView({ id, visible, onTitle, onReady, fontSize: requestedFontSize, projectId, onOpenPath }: Props): React.JSX.Element {
  // Tamanho indefinido faz o xterm medir a célula errado (texto minúsculo e espaçado); nunca repassa isso.
  const fontSize = Number.isFinite(requestedFontSize) ? requestedFontSize : TERMINAL_FONT.default
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onOpenPathRef = useRef(onOpenPath)
  onOpenPathRef.current = onOpenPath

  useEffect(() => {
    const container = containerRef.current!
    // windowsPty ajusta o xterm às particularidades do ConPTY; kittyKeyboard (xterm 6.1 beta) deixa
    // os agentes distinguirem combinações como Shift+Enter.
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: cssVar('--terminal-font-family'),
      fontSize,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      scrollback: 5000,
      drawBoldTextInBrightColors: true,
      windowsPty: { backend: 'conpty', buildNumber: window.kora.windowsBuild },
      vtExtensions: { kittyKeyboard: true },
      // Links OSC 8 (os que o Claude/Codex imprimem): sem isto o xterm pede confirmação num confirm() nativo.
      // Só http(s) chega ao navegador; o main recusa qualquer outro esquema.
      linkHandler: { activate: (_event, uri) => window.open(uri), allowNonHttpProtocols: false },
      ...currentTerminalLook()
    })
    const offTheme = onThemeChange(() => {
      const look = currentTerminalLook()
      term.options.theme = look.theme
      term.options.minimumContrastRatio = look.minimumContrastRatio
    })
    const fit = new FitAddon()
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    if (import.meta.env.DEV) devTerminals.set(id, term)

    term.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase()
      const copy = event.type === 'keydown' && event.ctrlKey && !event.altKey && key === 'c'
      if (copy && (event.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      // Ctrl+V (e Ctrl+Shift+V) ficam com o navegador, que dispara o evento "paste": texto segue pelo
      // xterm e imagem cai no onPaste abaixo. Deixar com o xterm mandaria ^V ao terminal e nada seria colado.
      if (event.ctrlKey && !event.altKey && key === 'v') return false
      return true
    })

    // Print colado com Ctrl+V vira arquivo e o terminal recebe o caminho, como se fosse arrastado:
    // Claude/Codex anexam imagem a partir do caminho colado. Texto segue o fluxo normal do xterm.
    const onPaste = (event: ClipboardEvent): void => {
      const item = [...(event.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (!file) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void file
        .arrayBuffer()
        .then((buffer) => window.kora.savePastedImage(new Uint8Array(buffer), file.type))
        .then((path) => term.paste(path.includes(' ') ? `"${path}"` : path))
        .catch((err: unknown) => term.write(`\r\n\x1b[31m[Kora] não foi possível colar a imagem: ${String(err)}\x1b[0m\r\n`))
    }
    container.addEventListener('paste', onPaste, true)

    // Caminho de arquivo do projeto impresso no terminal: Ctrl+clique abre no Kora (URLs seguem com o WebLinksAddon).
    const resolved = new Map<string, { at: number; value: Promise<{ rel: string; line: number | null } | null> }>()
    const resolveCached = (text: string): Promise<{ rel: string; line: number | null } | null> => {
      const hit = resolved.get(text)
      if (hit && Date.now() - hit.at < LINK_CACHE_MS) return hit.value
      const value = window.kora.resolveTerminalLink(projectId, text).catch(() => null)
      resolved.set(text, { at: Date.now(), value })
      return value
    }
    const pathLinks = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const candidates = findPathCandidates(text)
        if (candidates.length === 0) return callback(undefined)
        void Promise.all(candidates.map(async (c) => ({ c, target: await resolveCached(c.text) }))).then((found) => {
          const links = found.flatMap(({ c, target }) =>
            target
              ? [
                  {
                    range: { start: { x: c.start + 1, y }, end: { x: c.end, y } },
                    text: c.text,
                    decorations: { underline: true, pointerCursor: true },
                    hover: () => (container.title = 'Ctrl + clique para abrir o arquivo'),
                    leave: () => (container.title = ''),
                    activate: (event: MouseEvent) => event.ctrlKey && onOpenPathRef.current(target.rel, target.line)
                  }
                ]
              : []
          )
          callback(links.length ? links : undefined)
        })
      }
    })

    const unsubscribe = terminalBus.subscribe(id, (data) => term.write(data))
    const input = term.onData((data) => window.kora.writeTerminal(id, data))
    const resize = term.onResize(({ cols, rows }) => window.kora.resizeTerminal(id, cols, rows))
    const title = term.onTitleChange((raw) => {
      const t = meaningfulTitle(raw)
      if (t) onTitleRef.current(t)
    })

    let ready = false
    const markReady = (): void => {
      if (ready) return
      ready = true
      onReadyRef.current(term.cols, term.rows)
    }
    const observer = new ResizeObserver(() => {
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return
      fit.fit()
      markReady()
    })
    observer.observe(container)
    // Com a janela minimizada o Chromium não roda o ResizeObserver; sem esta reserva o shell nunca subiria.
    // O pty nasce no tamanho atual e o observer corrige quando a janela voltar a ser desenhada.
    const fallback = setTimeout(markReady, READY_FALLBACK_MS)

    return () => {
      clearTimeout(fallback)
      offTheme()
      container.removeEventListener('paste', onPaste, true)
      pathLinks.dispose()
      observer.disconnect()
      title.dispose()
      resize.dispose()
      input.dispose()
      unsubscribe()
      devTerminals.delete(id)
      webglRef.current = null
      term.dispose()
    }
  }, [id])

  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    fitRef.current?.fit()
  }, [fontSize])

  // WebGL só na aba visível: cada contexto custa ~22 MB de GPU e o Chromium tolera ~16 ao mesmo tempo.
  // A aba escondida devolve o contexto depois de um tempo, para alternar rápido entre abas não recriá-lo.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (!visible) {
      const timer = setTimeout(() => {
        webglRef.current?.dispose()
        webglRef.current = null
      }, WEBGL_RELEASE_MS)
      return () => clearTimeout(timer)
    }
    if (!webglRef.current) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          if (webglRef.current === webgl) webglRef.current = null
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        // Sem WebGL o xterm segue no renderer DOM.
      }
    }
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit()
      term.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  // Arquivo solto vindo do explorador vira o caminho colado, como o Explorer do Windows faz com o Windows Terminal.
  const onDrop = (event: React.DragEvent): void => {
    const path = event.dataTransfer.getData('text/plain')
    if (!event.dataTransfer.types.includes(FILE_MIME) || !path) return
    event.preventDefault()
    termRef.current?.paste(path.includes(' ') ? `"${path}" ` : `${path} `)
    termRef.current?.focus()
  }

  return (
    <div
      className={cn('absolute inset-0 bg-terminal pl-3 pt-2', !visible && 'invisible')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FILE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
