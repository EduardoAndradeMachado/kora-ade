import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { DESKTOP, type MobileCommand, type MobileTab, type TerminalSizeEvent, type TerminalSnapshot } from '@shared/mobile'
import { Icon } from '@/brand/icons'
import { currentTerminalLook, onThemeChange } from '@/lib/terminal-theme'
import { api } from './api'
import { pathForPrompt, uploadImage } from './images'
import { canRecord, onNativeAudio, startRecording, stopRecording, transcribeAudio } from './voice'
import { VoiceMeter } from './VoiceMeter'
import { SkeletonTerminal } from './Skeleton'

export interface TerminalChunk { id: string; data: string; sequence: number }

export interface SessionFeed {
  terminal: ((chunk: TerminalChunk) => void) | null
  size: ((event: TerminalSizeEvent) => void) | null
}

// Teclas que o teclado do celular não tem. Sequências do modo legado do terminal, as mesmas que o xterm
// manda quando o programa não pediu outro modo de teclado.
const KEYS: [string, string][] = [
  ['Esc', '\x1b'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['Enter', '\r']
]
// Úteis, mas não de toda hora: ficam no ⋯ para a barra não crescer.
const MORE_KEYS: [string, string][] = [
  ['Ctrl+C', '\x03'],
  ['Ctrl+B', '\x02'],
  ['Ctrl+S', '\x13'],
  ['Ctrl+X', '\x18'],
  // No Claude Code, troca o modo: normal, aceitar edições e planejar.
  ['Shift+Tab', '\x1b[Z'],
  ['Tab', '\t']
]

const MIN_COLS = 20
const MIN_ROWS = 5

interface Attached { path: string; preview: string }
// A tela da conversa desmonta ao abrir os arquivos ou outra aba; o que estava escrito em cada aba espera a volta.
const drafts = new Map<string, { text: string; images: Attached[] }>()

// O terminal do celular só mostra: as respostas automáticas do terminal (consulta de cor, de teclado) já vêm
// da janela do PC, e uma segunda resposta chegaria ao programa como se fosse digitada.
export function SessionView({ tab, device, connected, connection, feed, command, onError, dictation }: {
  tab: MobileTab
  device: string
  connected: boolean
  connection: number
  feed: React.MutableRefObject<SessionFeed>
  command(command: MobileCommand): Promise<unknown>
  onError(message: string): void
  dictation: boolean
}): React.JSX.Element {
  const [holder, setHolder] = useState<string | null>(tab.holder)
  // Até o histórico do PC chegar, o terminal mostra o esqueleto em vez de uma tela vazia.
  const [hydrating, setHydrating] = useState(true)
  const [draft, setDraft] = useState(() => drafts.get(tab.id)?.text ?? '')
  const [sending, setSending] = useState(false)
  const [images, setImages] = useState<Attached[]>(() => drafts.get(tab.id)?.images ?? [])
  const [uploading, setUploading] = useState(0)
  // Erro de imagem ou de envio aparece no campo, onde a pessoa agiu, e não no aviso do topo.
  const [composerError, setComposerError] = useState<string | null>(null)
  const [moreKeys, setMoreKeys] = useState(false)
  const [voice, setVoice] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const microphone = dictation && canRecord()
  const transcription = useRef<AbortController | null>(null)
  // A gravação que esta tela acompanha: o áudio de uma descartada chega atrasado e não pode cair no campo.
  const take = useRef<number | null>(null)
  const level = useRef<((level: number) => void) | null>(null)
  const listenLevel = useCallback((handler: ((level: number) => void) | null) => { level.current = handler }, [])
  const picker = useRef<HTMLInputElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const mount = useRef<HTMLDivElement>(null)
  const wanted = useRef<() => { cols: number; rows: number }>(() => ({ cols: 80, rows: 24 }))
  const queue = useRef(Promise.resolve())
  const live = tab.live

  const send = (next: MobileCommand): Promise<void> => {
    const run = queue.current.then(() => command(next)).then(() => {})
    queue.current = run.catch(() => {})
    return run
  }

  useEffect(() => {
    const element = mount.current
    if (!element || !live || !connected) return
    const term = new Terminal({
      allowProposedApi: true,
      fontSize: 13,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
      ...currentTerminalLook(),
      windowsPty: { backend: 'conpty' }
    })
    const fit = new FitAddon()
    const unicode = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.open(element)
    // O xterm dá foco ao textarea dele em todo toque (mousedown); no celular isso abriria o teclado para um terminal
    // que só mostra. Quem escreve é o campo da mensagem.
    term.textarea?.setAttribute('inputmode', 'none')
    const offTheme = onThemeChange(() => {
      const look = currentTerminalLook()
      term.options.theme = look.theme
      term.options.minimumContrastRatio = look.minimumContrastRatio
    })
    wanted.current = () => {
      const size = fit.proposeDimensions()
      return { cols: Math.max(MIN_COLS, Math.min(500, size?.cols ?? 80)), rows: Math.max(MIN_ROWS, Math.min(200, size?.rows ?? 24)) }
    }

    // Terminal no tamanho do PC não cabe na largura do celular: mostra reduzido em vez de cortar.
    const fitToWidth = (mine: boolean): void => {
      requestAnimationFrame(() => {
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
        if (!term.element || !screen) return
        const scale = mine ? 1 : Math.min(1, element.clientWidth / Math.max(1, screen.offsetWidth))
        term.element.style.transformOrigin = '0 0'
        term.element.style.transform = scale < 1 ? `scale(${scale})` : ''
      })
    }
    const applySize = (event: TerminalSizeEvent): void => {
      if (event.id !== tab.id) return
      setHolder(event.holder)
      if (term.cols !== event.cols || term.rows !== event.rows) term.resize(event.cols, event.rows)
      fitToWidth(event.holder === device)
    }

    let disposed = false

    let hydrated = false
    let sequence = -1
    const queued: TerminalChunk[] = []
    const receive = (chunk: TerminalChunk): void => {
      if (chunk.id !== tab.id || chunk.sequence <= sequence) return
      if (!hydrated) {
        queued.push(chunk)
        return
      }
      sequence = chunk.sequence
      term.write(chunk.data)
    }
    feed.current.terminal = receive
    feed.current.size = applySize

    // O terminal é o mesmo no PC: mudar de tamanho redesenha o agente e mexe na janela do PC. Teclado e a fileira do
    // ⋯ só encolhem a altura por um tempo, então o tamanho fica o da maior altura nesta largura e a área mostra a
    // parte de baixo (cursor e campo do agente) recortando as linhas de cima. Largura nova (girar) redimensiona.
    const area = element.parentElement!
    let steady = { width: 0, height: 0, mount: 0 }
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      const width = area.clientWidth
      const height = area.clientHeight
      if (width === steady.width && height < steady.height) {
        element.style.top = 'auto'
        element.style.height = `${steady.mount}px`
        return
      }
      element.style.top = ''
      element.style.height = ''
      if (width === steady.width && height === steady.height) return
      steady = { width, height, mount: element.clientHeight }
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed || !hydrated) return
        void send({ type: 'resize', tabId: tab.id, ...wanted.current() }).catch((error: Error) => onError(error.message))
      }, 150)
    })
    observer.observe(area)

    // O Codex abre na tela alternativa e rola o histórico ele mesmo, pela roda do mouse: ali o terminal não tem o
    // que rolar. Arrastar o dedo vira a roda (SGR, como o xterm do PC manda), uma volta por linha arrastada.
    let touchY: number | null = null
    let wheel = 0
    let wheelTimer: ReturnType<typeof setTimeout> | undefined
    const appScrolls = (): boolean => term.buffer.active.type === 'alternate' && term.modes.mouseTrackingMode !== 'none'
    const flushWheel = (): void => {
      wheelTimer = undefined
      // Quatro voltas por envio cabem no limite de 64 caracteres do comando keys.
      const steps = Math.max(-4, Math.min(4, wheel))
      wheel -= steps
      if (steps && !disposed) {
        const event = `\x1b[<${steps > 0 ? 64 : 65};${Math.ceil(term.cols / 2)};${Math.ceil(term.rows / 2)}M`
        void send({ type: 'keys', tabId: tab.id, data: event.repeat(Math.abs(steps)) }).catch((error: Error) => onError(error.message))
      }
      if (wheel) wheelTimer = setTimeout(flushWheel, 40)
    }
    const touchStart = (event: TouchEvent): void => {
      touchY = event.touches.length === 1 ? event.touches[0]!.clientY : null
      // Tocar no terminal larga o campo: com ele focado, o teclado segura a tela e o navegador puxa o campo de volta
      // à vista, por cima da rolagem. O rascunho fica no estado; tocar no campo de novo retoma.
      if (document.activeElement === field.current) field.current?.blur()
    }
    const touchMove = (event: TouchEvent): void => {
      if (touchY === null || !appScrolls()) return
      const step = (term.dimensions?.css.cell.height || 16) * 1.2
      const lines = Math.trunc((event.touches[0]!.clientY - touchY) / step)
      if (!lines) return
      touchY += lines * step
      // Dedo para baixo puxa o conteúdo para baixo: mostra o que está acima, que é a roda para cima.
      wheel += lines
      wheelTimer ??= setTimeout(flushWheel, 0)
    }
    const touchEnd = (): void => { touchY = null }
    // Captura: o xterm trata o toque nos elementos dele e não deixa o evento subir até aqui.
    element.addEventListener('touchstart', touchStart, { passive: true, capture: true })
    element.addEventListener('touchmove', touchMove, { passive: true, capture: true })
    element.addEventListener('touchend', touchEnd, { capture: true })
    element.addEventListener('touchcancel', touchEnd, { capture: true })

    void (async () => {
      try {
        // Entrar na aba traz o tamanho para o celular; a foto vem depois, já no tamanho novo.
        await send({ type: 'attach', tabId: tab.id, ...wanted.current() })
        const snapshot = await api<TerminalSnapshot | null>(`snapshot?tab=${encodeURIComponent(tab.id)}`)
        if (disposed) return
        if (snapshot) {
          term.resize(snapshot.cols, snapshot.rows)
          term.write(snapshot.data)
          sequence = snapshot.sequence
        }
        hydrated = true
        setHydrating(false)
        for (const chunk of queued) receive(chunk)
        queued.length = 0
      } catch (error) {
        if (!disposed) {
          setHydrating(false)
          onError(error instanceof Error ? error.message : String(error))
        }
      }
    })()

    return () => {
      disposed = true
      clearTimeout(resizeTimer)
      clearTimeout(wheelTimer)
      element.removeEventListener('touchstart', touchStart, { capture: true })
      element.removeEventListener('touchmove', touchMove, { capture: true })
      element.removeEventListener('touchend', touchEnd, { capture: true })
      element.removeEventListener('touchcancel', touchEnd, { capture: true })
      observer.disconnect()
      offTheme()
      if (feed.current.terminal === receive) feed.current.terminal = null
      if (feed.current.size === applySize) feed.current.size = null
      term.dispose()
      void command({ type: 'detach', tabId: tab.id }).catch(() => {})
    }
  }, [tab.id, live, connected, connection, device, feed, command, onError])

  useEffect(() => {
    if (draft || images.length > 0) drafts.set(tab.id, { text: draft, images })
    else drafts.delete(tab.id)
  }, [tab.id, draft, images])

  // O campo cresce com o texto até 140 px (o max-height do CSS); depois rola por dentro.
  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  // O texto cai no campo para revisar antes de enviar: uma palavra mal entendida não vai direto para o terminal.
  useEffect(() => {
    if (!microphone) return
    const off = onNativeAudio((event) => {
      if (event.tipo === 'gravando') {
        take.current = event.gravacao ?? null
        return setVoice('recording')
      }
      if (event.gravacao !== undefined && event.gravacao !== take.current) return
      if (event.tipo === 'nivel') return level.current?.(event.valor)
      take.current = null
      if (event.tipo !== 'audio') {
        setVoice('idle')
        if (event.tipo === 'curto') setComposerError('Gravação curta demais: toque no microfone, fale e toque em ✓ para transcrever.')
        if (event.tipo === 'erro') setComposerError(event.mensagem)
        return
      }
      const abort = new AbortController()
      transcription.current = abort
      setVoice('transcribing')
      transcribeAudio(event.base64, event.mime, abort.signal)
        .then((text) => {
          if (abort.signal.aborted) return
          if (!text) return setComposerError('Não deu para entender o áudio. Fale de novo, mais perto do celular.')
          setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text))
        })
        .catch((error: Error) => { if (!abort.signal.aborted) setComposerError(error.message) })
        .finally(() => {
          if (transcription.current !== abort) return
          transcription.current = null
          setVoice('idle')
        })
    })
    return () => {
      off()
      stopRecording(false)
      transcription.current?.abort()
    }
  }, [microphone])
  // Cancelar na transcrição fecha o pedido; o PC percebe e apaga o trabalho no Transcritor, que para de processar.
  const cancelVoice = (): void => {
    if (voice === 'recording') stopRecording(false)
    take.current = null
    transcription.current?.abort()
    transcription.current = null
    setVoice('idle')
  }

  const keys = (data: string): void => {
    void send({ type: 'keys', tabId: tab.id, data }).catch((error: Error) => onError(error.message))
  }
  // Igual ao Ctrl+V com print no PC: a imagem vira arquivo no PC e o caminho vai na mensagem, que o Claude e o
  // Codex anexam.
  const attach = async (files: File[]): Promise<void> => {
    setComposerError(null)
    for (const file of files) {
      setUploading((count) => count + 1)
      try {
        const image = await uploadImage(file)
        setImages((list) => [...list, image])
      } catch (error) {
        setComposerError(error instanceof Error ? error.message : String(error))
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }
  const removeImage = (path: string): void => setImages((list) => list.filter((image) => image.path !== path))
  const clear = (): void => {
    setDraft('')
    setImages([])
    setComposerError(null)
  }
  const submit = (): void => {
    const text = draft.trim()
    if ((!text && images.length === 0) || uploading) return
    const sent = { text: draft, images }
    setComposerError(null)
    setSending(true)
    // O campo esvazia no toque, não na resposta do PC: quem sai e volta antes dela não acha o texto pronto para
    // mandar de novo. Se o envio falha, o texto volta, a menos que a pessoa já tenha escrito outro.
    setDraft('')
    setImages([])
    drafts.delete(tab.id)
    void send({ type: 'send', tabId: tab.id, text, images: images.map((image) => pathForPrompt(image.path)) })
      .catch((error: Error) => {
        if (!drafts.has(tab.id)) drafts.set(tab.id, sent)
        setDraft((current) => current || sent.text)
        setImages((current) => (current.length > 0 ? current : sent.images))
        setComposerError(error.message)
      })
      .finally(() => setSending(false))
  }

  if (!live) return <></>
  const elsewhere = holder !== null && holder !== device
  return <>
    {elsewhere && <button className="size-banner" onClick={() => void send({ type: 'attach', tabId: tab.id, ...wanted.current() }).catch((error: Error) => onError(error.message))}>
      {holder === DESKTOP ? 'Em uso no PC, no tamanho dele.' : 'Em uso em outro celular.'} Toque para ajustar a este celular.
    </button>}
    <div className="terminal-area">
      <div className="terminal-mount" ref={mount} />
      {hydrating && <SkeletonTerminal label="Abrindo a conversa…" />}
    </div>
    {moreKeys && <nav className="terminal-keys more-keys" aria-label="Mais teclas do terminal">
      {MORE_KEYS.map(([label, data]) => <button disabled={!connected} key={label} onClick={() => keys(data)}>{label}</button>)}
    </nav>}
    <nav className="terminal-keys" aria-label="Teclas do terminal">
      {KEYS.map(([label, data]) => <button disabled={!connected} key={label} onClick={() => keys(data)}>{label}</button>)}
      <button className="more-keys-toggle" aria-label="Mais teclas" aria-expanded={moreKeys} onClick={() => setMoreKeys((open) => !open)}>⋯</button>
    </nav>
    {(() => {
      const ready = !sending && uploading === 0 && voice === 'idle' && connected && (draft.trim() !== '' || images.length > 0)
      const thumbs = (images.length > 0 || uploading > 0) && <div className="composer-images" aria-label="Imagens anexadas">
        {images.map((image) => <figure key={image.path}>
          {image.preview ? <img src={image.preview} alt="Imagem anexada" /> : <Icon name="imagem" />}
          <button type="button" className="remove-image" aria-label="Remover imagem" onClick={() => removeImage(image.path)}><Icon name="fechar" /></button>
        </figure>)}
        {uploading > 0 && <figure className="uploading" aria-label="Enviando imagem ao PC"><span /></figure>}
      </div>
      // Caixa única, como no app do Claude e do ChatGPT: miniaturas e texto dentro, imagem e enviar embaixo.
      // Sair da tela descarta a gravação e a transcrição em curso: ditando, o arrastar de lado não navega.
      return <form className="composer" data-no-swipe data-swipe-lock={voice === 'idle' ? undefined : ''} onSubmit={(event) => { event.preventDefault(); submit() }}>
        <input ref={picker} type="file" accept="image/*" multiple hidden aria-label="Escolher imagem" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void attach(files) }} />
        <div className="composer-box">
          {composerError && <p role="alert" className="composer-error"><Icon name="alerta" /><span>{composerError}</span><button type="button" aria-label="Dispensar aviso" onClick={() => setComposerError(null)}><Icon name="fechar" /></button></p>}
          {thumbs}
          <textarea ref={field} aria-label="Mensagem para a sessão" placeholder="Mensagem para a sessão" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} />
          {/* Ditando, a linha vira descartar, ondas e transcrever: anexar e enviar saem para não mandar a mensagem no meio. */}
          {voice === 'idle' ? <div className="composer-actions">
            <div className="composer-tools">
              <button type="button" className="attach-button" aria-label="Anexar imagem" disabled={!connected} onClick={() => picker.current?.click()}><Icon name="novaAba" /></button>
              {(draft !== '' || images.length > 0) && <button type="button" className="clear-draft" aria-label="Limpar mensagem" onClick={clear}><Icon name="excluir" /></button>}
            </div>
            <div className="composer-send">
              {microphone && <button type="button" className="mic-button" aria-label="Gravar áudio" disabled={!connected}
                onClick={() => { setComposerError(null); startRecording() }}>
                <Icon name="microfone" />
              </button>}
              <button className={`send-button ${ready ? 'ready' : ''}`} aria-label="Enviar" disabled={!ready}><Icon name="setaCima" /></button>
            </div>
          </div> : <div className="composer-actions dictating">
            <button type="button" className="voice-cancel" aria-label={voice === 'recording' ? 'Descartar gravação' : 'Cancelar transcrição'} onClick={cancelVoice}><Icon name="fechar" /></button>
            {voice === 'recording'
              ? <VoiceMeter listen={listenLevel} />
              : <p className="voice-status" role="status"><span className="mic-spinner" />Transcrevendo no PC…</p>}
            {voice === 'recording' && <button type="button" className="voice-confirm" aria-label="Parar e transcrever" onClick={() => { setVoice('transcribing'); stopRecording(true) }}><Icon name="ok" /></button>}
          </div>}
        </div>
      </form>
    })()}
  </>
}
