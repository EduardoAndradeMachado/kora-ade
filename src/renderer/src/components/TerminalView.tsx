import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { meaningfulTitle } from '@shared/terminal-title'
import { terminalBus } from '@/lib/terminal-bus'
import { registerScrollback } from '@/lib/scrollback'
import { screenText } from '@shared/scrollback'
import { currentTerminalLook, onThemeChange } from '@/lib/terminal-theme'
import { TERMINAL_FONT } from '@shared/state'
import { cn } from '@/lib/utils'
import { FILE_MIME } from '@/lib/drag'
import { isCopiedPath } from '@/lib/copied-path'
import { findPathCandidates } from '@shared/terminal-links'
import { DESKTOP, type MobileDevice, type TerminalSizeEvent } from '@shared/mobile'
import { Button } from '@/brand/Button'

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
// Histórico salvo é leitura local: se demorar mais que isto, a aba abre vazia em vez de esperar.
const RESTORE_TIMEOUT_MS = 800
// O que veio antes é uma foto de um processo que não existe mais; o divisor evita ler como se fosse ao vivo.
const RESTORED_DIVIDER = '\x1b[2m── conteúdo anterior (processo encerrado) ──\x1b[22m\r\n'

// Mesma altura da faixa em main.css (.terminal-phone): o terminal começa logo abaixo dela.
const STRIP_HEIGHT = 44
// O fit desconta a barra de rolagem do xterm da largura; a conta feita à mão desconta igual.
const SCROLLBAR_WIDTH = 14
const MAX_ZOOM_FONT = 32

function useDeviceName(id: string | null): string | null {
  const [devices, setDevices] = useState<MobileDevice[]>([])
  useEffect(() => {
    if (!id) return
    let alive = true
    void window.kora.mobileStatus().then((status) => { if (alive) setDevices(status.devices) }, () => {})
    const off = window.kora.onMobileStatus((status) => setDevices(status.devices))
    return () => {
      alive = false
      off()
    }
  }, [id])
  return id ? (devices.find((device) => device.id === id)?.name ?? null) : null
}

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
  // Celular usando o terminal: o pty está no tamanho dele e a janela só mostra, sem refazer o fit.
  const [phone, setPhone] = useState<string | null>(null)
  const phoneName = useDeviceName(phone)
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const remoteRef = useRef(false)
  const syncSizeRef = useRef<() => void>(() => {})

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

    // Foto do buffer no momento de suspender/esconder.
    const unregisterScrollback = registerScrollback(id, () => screenText(term.buffer.active))

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && remoteRef.current) window.kora.takeTerminal(id)
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
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (isCopiedPath(text)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        window.kora.writeTerminal(id, text)
        return
      }
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

    // Até a foto da tela chegar, a saída espera: aba aberta pelo celular já tem conteúdo que a janela não viu.
    let hydrated = false
    const queued: { data: string; sequence?: number }[] = []
    const unsubscribe = terminalBus.subscribe(id, (data, sequence) => {
      if (hydrated) term.write(data)
      else queued.push({ data, sequence })
    })
    const input = term.onData((data) => window.kora.writeTerminal(id, data))
    const resize = term.onResize(({ cols, rows }) => {
      if (!remoteRef.current) window.kora.resizeTerminal(id, cols, rows)
    })
    const title = term.onTitleChange((raw) => {
      const t = meaningfulTitle(raw)
      if (t) onTitleRef.current(t)
    })
    // A letra cresce até o terminal do celular ocupar o painel. Só a janela muda; o pty segue no tamanho do celular.
    const layoutPhone = (): void => {
      const base = fontSizeRef.current
      const cell = term.dimensions?.css.cell
      if (remoteRef.current && cell?.width) {
        const ratio = base / (term.options.fontSize ?? base)
        const scale = Math.min(
          container.clientWidth / (term.cols * cell.width * ratio),
          (container.clientHeight - STRIP_HEIGHT) / (term.rows * cell.height * ratio)
        )
        const next = Math.max(base, Math.min(MAX_ZOOM_FONT, Math.floor(base * scale)))
        if (term.options.fontSize !== next) term.options.fontSize = next
      } else if (term.options.fontSize !== base) {
        term.options.fontSize = base
      }
    }
    // Com o celular no comando, a janela informa o tamanho que quer sem aplicar; vale quando o PC voltar.
    // A letra ampliada não conta: o tamanho que o PC quer é medido na letra normal.
    const syncSize = (): void => {
      if (!remoteRef.current) {
        fit.fit()
        return
      }
      const cell = term.dimensions?.css.cell
      const ratio = fontSizeRef.current / (term.options.fontSize ?? fontSizeRef.current)
      const wanted = ratio === 1 ? fit.proposeDimensions() : cell?.width ? {
        cols: Math.max(2, Math.floor((container.clientWidth - SCROLLBAR_WIDTH) / (cell.width * ratio))),
        rows: Math.max(1, Math.floor(container.clientHeight / (cell.height * ratio)))
      } : undefined
      if (wanted) window.kora.resizeTerminal(id, wanted.cols, wanted.rows)
      layoutPhone()
    }
    syncSizeRef.current = syncSize
    const applySize = (event: TerminalSizeEvent): void => {
      if (event.id !== id) return
      const isRemote = event.holder !== DESKTOP
      if (isRemote && (term.cols !== event.cols || term.rows !== event.rows)) {
        remoteRef.current = true
        term.resize(event.cols, event.rows)
      }
      remoteRef.current = isRemote
      setPhone(isRemote ? event.holder : null)
      layoutPhone()
      if (!isRemote) fit.fit()
    }
    const offSize = window.kora.onTerminalSize(applySize)

    let ready = false
    let restored = false
    let disposed = false
    const markReady = (): void => {
      if (ready || !restored) return
      ready = true
      onReadyRef.current(term.cols, term.rows)
    }
    const hydrate = (current: Awaited<ReturnType<typeof window.kora.terminalSnapshot>> | null): void => {
      if (disposed) return
      const snapshot = current?.snapshot ?? null
      if (current?.size && current.size.holder !== DESKTOP) applySize(current.size)
      else if (snapshot) term.resize(snapshot.cols, snapshot.rows)
      if (snapshot) term.write(snapshot.data)
      for (const chunk of queued) {
        if (!snapshot || chunk.sequence === undefined || chunk.sequence > snapshot.sequence) term.write(chunk.data)
      }
      queued.length = 0
      hydrated = true
      if (snapshot && !remoteRef.current) fit.fit()
    }
    const finishRestore = (saved: string | null): void => {
      if (restored || disposed) return
      clearTimeout(restoreTimer)
      restored = true
      if (saved) term.write(`${saved.replace(/\r?\n/g, '\r\n')}\r\n${RESTORED_DIVIDER}`)
      void window.kora.terminalSnapshot(id).then(hydrate, () => hydrate(null))
      markReady()
    }
    // O spawn espera o histórico: assim o shell novo imprime depois do divisor, não no meio dele.
    const restoreTimer = setTimeout(() => finishRestore(null), RESTORE_TIMEOUT_MS)
    void window.kora.loadScrollback(id).then(finishRestore, () => finishRestore(null))
    const observer = new ResizeObserver(() => {
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return
      syncSize()
      markReady()
    })
    observer.observe(container)
    // Com a janela minimizada o Chromium não roda o ResizeObserver; sem esta reserva o shell nunca subiria.
    // O pty nasce no tamanho atual e o observer corrige quando a janela voltar a ser desenhada.
    const fallback = setTimeout(markReady, READY_FALLBACK_MS)

    return () => {
      clearTimeout(fallback)
      clearTimeout(restoreTimer)
      disposed = true
      unregisterScrollback()
      offTheme()
      container.removeEventListener('paste', onPaste, true)
      pathLinks.dispose()
      observer.disconnect()
      offSize()
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
    syncSizeRef.current()
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
      syncSizeRef.current()
      term.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  // Arquivo solto (do explorador do Kora ou do Explorer do Windows) vira o caminho colado, como o Windows
  // Terminal faz; vários viram caminhos separados por espaço. Claude/Codex anexam imagem a partir do caminho.
  const onDrop = (event: React.DragEvent): void => {
    const paths = event.dataTransfer.types.includes(FILE_MIME)
      ? [event.dataTransfer.getData('text/plain')]
      : [...event.dataTransfer.files].map((file) => window.kora.pathForFile(file))
    const pasted = paths.filter(Boolean).map((path) => (path.includes(' ') ? `"${path}"` : path))
    if (pasted.length === 0) return
    event.preventDefault()
    termRef.current?.paste(`${pasted.join(' ')} `)
    termRef.current?.focus()
  }

  return (
    <div
      className={cn('absolute inset-0 bg-terminal pl-3 pt-2', !visible && 'invisible')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FILE_MIME) && !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    >
      {/* O container continua do tamanho da janela: é ele que o fit mede para guardar o tamanho que o PC quer
          quando voltar. Só o .xterm muda de lugar (main.css). */}
      <div ref={containerRef} className={cn('h-full w-full', phone && 'terminal-phone')} />
      {phone && (
        <div
          role="status"
          className="absolute inset-x-0 top-0 flex items-center gap-3 border-b border-[color-mix(in_oklab,var(--brand-amber)_45%,transparent)] bg-[color-mix(in_oklab,var(--brand-amber)_14%,var(--card))] px-4 text-xs text-foreground"
          style={{ height: STRIP_HEIGHT }}
        >
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative size-2 rounded-full bg-emerald-500" />
          </span>
          <span className="min-w-0 truncate">
            Em uso no celular <strong className="font-semibold">{phoneName ?? 'Celular'}</strong>
            <span className="text-muted-foreground"> · digite aqui para voltar ao PC</span>
          </span>
          <span className="flex-1" />
          <Button
            className="shrink-0 py-1.5"
            aria-label={`Em uso no celular ${phoneName ?? ''}. Usar no PC`}
            onClick={() => {
              window.kora.takeTerminal(id)
              termRef.current?.focus()
            }}
          >
            Usar no PC
          </Button>
        </div>
      )}
    </div>
  )
}
