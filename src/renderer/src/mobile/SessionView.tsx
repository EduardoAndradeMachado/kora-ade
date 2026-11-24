import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { DESKTOP, SEND_TEXT_MAX, type MobileCommand, type MobileTab, type TerminalSizeEvent, type TerminalSnapshot } from '@shared/mobile'
import { Icon } from '@/brand/icons'
import { currentTerminalLook, onThemeChange } from '@/lib/terminal-theme'
import { api, koraApp } from './api'
import { pathForPrompt, uploadAttachment } from './images'
import { canRecord, discardAudio, onNativeAudio, recoverAudio, startRecording, stopRecording, transcribeAudio } from './voice'
import { VoiceMeter } from './VoiceMeter'
import { SkeletonTerminal } from './Skeleton'
import { targetAt } from './terminalTap'
import { firstVisibleRow } from './terminalWindow'
import { ReadingView } from './ReadingView'
import type { TranscriptEvent } from '@shared/transcript'
import { agentCommands, opensTerminal } from '@shared/agent-commands'

// Toque curto e parado é toque em link; mais longo é seleção de texto, e com o dedo andando é rolagem.
const TAP_MS = 450
const TAP_MOVE = 10

export interface TerminalChunk { id: string; data: string; sequence: number }

export interface SessionFeed {
  terminal: ((chunk: TerminalChunk) => void) | null
  size: ((event: TerminalSizeEvent) => void) | null
  transcript: ((event: TranscriptEvent) => void) | null
}

// Teclas que o teclado do celular não tem. Sequências do modo legado do terminal, as mesmas que o xterm
// manda quando o programa não pediu outro modo de teclado.
const KEYS: [string, string][] = [
  ['Esc', '\x1b'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['⌫', '\x7f'],
  ['Enter', '\r']
]
// O agente leva um instante para redesenhar depois da mudança de altura; a foto pedida antes viria velha.
const REDRAW_SETTLE_MS = 700
// Úteis, mas não de toda hora: ficam no ⋯ para a barra não crescer.
const MORE_KEYS: [string, string][] = [
  ['Ctrl+C', '\x03'],
  ['Ctrl+B', '\x02'],
  ['Ctrl+S', '\x13'],
  ['Ctrl+X', '\x18'],
  // No Claude Code, troca o modo: normal, aceitar edições e planejar.
  ['Shift+Tab', '\x1b[Z'],
  // Alt no terminal é Esc seguido da tecla. No Windows o Claude Code troca o modo pelo Alt+M.
  ['Alt+M', '\x1bm'],
  ['Tab', '\t'],
  ['PgUp', '\x1b[5~'],
  ['PgDn', '\x1b[6~'],
  ['Ctrl+End', '\x1b[1;5F']
]

const MIN_COLS = 20
const MIN_ROWS = 5

// name só em arquivo que não é imagem: ele vai como caminho no texto, e não como anexo.
interface Attached { path: string; preview: string; name?: string }
// A tela da conversa desmonta ao abrir os arquivos ou outra aba; o que estava escrito em cada aba espera a volta.
const drafts = new Map<string, { text: string; images: Attached[] }>()
// O texto também fica no aparelho: o Android pode recarregar a página enquanto o seletor de imagem está na frente, e
// o Map vai junto. A imagem não: a miniatura é um endereço da página que morreu.
const DRAFT_TEXT_KEY = 'kora-rascunhos'
function storedDraftTexts(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFT_TEXT_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
  } catch { return {} }
}
function storeDraftText(tabId: string, text: string): void {
  try {
    const all = storedDraftTexts()
    if (text) all[tabId] = text
    else if (tabId in all) delete all[tabId]
    else return
    localStorage.setItem(DRAFT_TEXT_KEY, JSON.stringify(all))
  } catch { /* sem armazenamento, o rascunho dura até a página fechar */ }
}

// O terminal do celular só mostra: as respostas automáticas do terminal (consulta de cor, de teclado) já vêm
// da janela do PC, e uma segunda resposta chegaria ao programa como se fosse digitada.
export function SessionView({ tab, device, connected, connection, feed, command, onError, onOpenFile, dictation, reading = false, onTerminal, modelSheet = false, onModelSheet }: {
  tab: MobileTab
  device: string
  connected: boolean
  connection: number
  feed: React.MutableRefObject<SessionFeed>
  command(command: MobileCommand): Promise<unknown>
  onError(message: string): void
  onOpenFile(path: string, line?: number): void
  dictation: boolean
  // Modo leitura: a conversa vem do arquivo do Claude, sem entrar no terminal (o tamanho no PC não muda).
  reading?: boolean
  onTerminal?(): void
  modelSheet?: boolean
  onModelSheet?(open: boolean): void
}): React.JSX.Element {
  const openFile = useRef(onOpenFile)
  openFile.current = onOpenFile
  const [holder, setHolder] = useState<string | null>(tab.holder)
  // Até o histórico do PC chegar, o terminal mostra o esqueleto em vez de uma tela vazia.
  const [hydrating, setHydrating] = useState(true)
  const [draft, setDraft] = useState(() => drafts.get(tab.id)?.text ?? storedDraftTexts()[tab.id] ?? '')
  const [sending, setSending] = useState(false)
  const [images, setImages] = useState<Attached[]>(() => drafts.get(tab.id)?.images ?? [])
  const [uploading, setUploading] = useState(0)
  // Erro de imagem ou de envio aparece no campo, onde a pessoa agiu, e não no aviso do topo.
  const [composerError, setComposerError] = useState<string | null>(null)
  // Skills do Claude para o menu "/": pedidas ao PC na primeira vez que a mensagem começa com barra.
  const [skills, setSkills] = useState<{ name: string; description: string }[] | null>(null)
  const [moreKeys, setMoreKeys] = useState(false)
  // Cada Redesenhar refaz o terminal daqui com uma foto nova do PC, depois de o agente redesenhar a tela.
  const [redraws, setRedraws] = useState(0)
  const [voice, setVoice] = useState<'idle' | 'recording' | 'saved' | 'transcribing'>('idle')
  const audioDraft = useRef<{ base64: string; mime: string } | null>(null)
  const recoveryAllowed = useRef(true)
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
    if (!element || !live || !connected || reading) return
    let oscOpened = 0
    // No app, navegar para outro endereço cai no shouldOverrideUrlLoading da MainActivity, que manda a página de fora ao
    // navegador do celular e deixa o Kora onde está; o window.open depende de o WebView aceitar abrir janela. No navegador,
    // aba nova.
    const openUrl = (uri: string): void => {
      if (koraApp()) location.assign(uri)
      else window.open(uri, '_blank')
    }
    const term = new Terminal({
      allowProposedApi: true,
      fontSize: 13,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
      ...currentTerminalLook(),
      windowsPty: { backend: 'conpty' },
      // Link OSC 8 (os que o Claude e o Codex imprimem). Sem isto o xterm pede confirmação num confirm(), que o
      // WebView do app engole sem mostrar.
      linkHandler: { activate: (_event, uri) => { oscOpened = Date.now(); openUrl(uri) }, allowNonHttpProtocols: false }
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
        schedulePlace()
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
    // ⋯ só encolhem a altura por um tempo, então o tamanho fica o da maior altura nesta largura e a área recorta a
    // faixa de linhas em volta do cursor (firstVisibleRow). Largura nova (girar) redimensiona.
    const area = element.parentElement!
    let steady = { width: 0, height: 0, mount: 0 }
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let clipped = false
    const placeClip = (): void => {
      if (!clipped) return
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      const box = screen?.getBoundingClientRect()
      // Altura da linha como aparece, já com a redução do tamanho do PC.
      const line = box && term.rows ? box.height / term.rows : 0
      const inset = (steady.height - steady.mount) / 2
      const room = area.clientHeight - 2 * inset
      const fits = line ? Math.max(1, Math.floor(room / line)) : term.rows
      const first = firstVisibleRow(term.buffer.active, term.rows, fits)
      const lead = box ? box.top - element.getBoundingClientRect().top : 0
      // No topo, a primeira linha encosta em cima; no meio ou no fim, a última da faixa encosta embaixo e a sobra
      // mostra um pedaço da de cima, em vez de uma tira vazia.
      const top = first === 0 ? inset - lead : inset + room - lead - (first + fits) * line
      element.style.top = `${top}px`
      element.style.height = `${steady.mount}px`
    }
    let placing = 0
    const schedulePlace = (): void => {
      if (!clipped || placing) return
      placing = requestAnimationFrame(() => { placing = 0; if (!disposed) placeClip() })
    }
    const placeEvents = [term.onWriteParsed(schedulePlace), term.onScroll(schedulePlace), term.onResize(schedulePlace)]
    const observer = new ResizeObserver(() => {
      const width = area.clientWidth
      const height = area.clientHeight
      if (width === steady.width && height < steady.height) {
        clipped = true
        placeClip()
        return
      }
      clipped = false
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
    // Toque em URL ou caminho de arquivo. O PC descobre o link no hover, antes do clique; no toque não há hover, então
    // o link é procurado na hora, na célula tocada.
    const openAt = (clientX: number, clientY: number): void => {
      if (Date.now() - oscOpened < 500 || term.hasSelection()) return
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      const box = screen?.getBoundingClientRect()
      if (!box || !box.width || !box.height) return
      const x = Math.floor(((clientX - box.left) / box.width) * term.cols)
      const row = Math.floor(((clientY - box.top) / box.height) * term.rows)
      if (x < 0 || x >= term.cols || row < 0 || row >= term.rows) return
      const buffer = term.buffer.active
      const target = targetAt(buffer, term.cols, x, buffer.viewportY + row)
      if (!target) return
      if (target.kind === 'url') return openUrl(target.text)
      const resolve = (text: string): Promise<{ rel: string; line: number | null } | null> =>
        api(`resolve-link?project=${encodeURIComponent(tab.projectId)}&text=${encodeURIComponent(text)}`)
      void resolve(target.text)
        .then((found) => found ?? (target.alone ? resolve(target.alone) : null))
        .then((found) => { if (found && !disposed) openFile.current(found.rel, found.line ?? undefined) }, () => {})
    }
    // O xterm chama preventDefault no toque, e aí o navegador não gera mousedown nem click: o toque é reconhecido pelos
    // eventos de ponteiro. O link OSC 8 só o xterm conhece; ele o ativa com o mouse passando por cima e clicando,
    // então o toque é repassado a ele assim antes da busca do texto.
    let touchDown: { x: number; y: number; at: number } | null = null
    let touchTapped = 0
    const pointerDown = (event: PointerEvent): void => {
      touchDown = event.pointerType === 'mouse' || !event.isPrimary ? null : { x: event.clientX, y: event.clientY, at: Date.now() }
    }
    const pointerUp = (event: PointerEvent): void => {
      const down = touchDown
      touchDown = null
      if (!down || Date.now() - down.at > TAP_MS || Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_MOVE) return
      touchTapped = Date.now()
      const under = document.elementFromPoint(event.clientX, event.clientY)
      if (under && element.contains(under)) {
        const mouse = { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY, button: 0, view: window }
        under.dispatchEvent(new MouseEvent('mousemove', mouse))
        under.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }))
        under.dispatchEvent(new MouseEvent('mouseup', mouse))
      }
      openAt(event.clientX, event.clientY)
    }
    // Clique de mouse (PC com a página do celular). Se o navegador também gerar o click depois do toque, ele já foi tratado.
    const click = (event: MouseEvent): void => { if (Date.now() - touchTapped > 700) openAt(event.clientX, event.clientY) }
    element.addEventListener('pointerdown', pointerDown, { capture: true })
    element.addEventListener('pointerup', pointerUp, { capture: true })
    element.addEventListener('click', click)
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
      cancelAnimationFrame(placing)
      for (const event of placeEvents) event.dispose()
      element.removeEventListener('touchstart', touchStart, { capture: true })
      element.removeEventListener('touchmove', touchMove, { capture: true })
      element.removeEventListener('touchend', touchEnd, { capture: true })
      element.removeEventListener('touchcancel', touchEnd, { capture: true })
      element.removeEventListener('pointerdown', pointerDown, { capture: true })
      element.removeEventListener('pointerup', pointerUp, { capture: true })
      element.removeEventListener('click', click)
      observer.disconnect()
      offTheme()
      if (feed.current.terminal === receive) feed.current.terminal = null
      if (feed.current.size === applySize) feed.current.size = null
      term.dispose()
      void command({ type: 'detach', tabId: tab.id }).catch(() => {})
    }
  }, [tab.id, live, connected, connection, device, feed, command, onError, redraws, reading])

  useEffect(() => {
    if (draft || images.length > 0) drafts.set(tab.id, { text: draft, images })
    else drafts.delete(tab.id)
    storeDraftText(tab.id, draft)
  }, [tab.id, draft, images])

  // O campo cresce com o texto até 140 px (o max-height do CSS); depois rola por dentro.
  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  const transcribePending = (): void => {
    const audio = audioDraft.current
    if (!audio || transcription.current) return
    const abort = new AbortController()
    transcription.current = abort
    setComposerError(null)
    setVoice('transcribing')
    transcribeAudio(audio.base64, audio.mime, abort.signal)
      .then((text) => {
        if (abort.signal.aborted) return
        if (!text.trim()) throw new Error('Não deu para entender o áudio. Você pode tentar transcrever novamente ou descartar.')
        setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text))
        audioDraft.current = null
        take.current = null
        discardAudio()
      })
      .catch((error: Error) => { if (!abort.signal.aborted) setComposerError(`${error.message} O áudio continua guardado neste chat.`) })
      .finally(() => {
        if (transcription.current !== abort) return
        transcription.current = null
        setVoice(audioDraft.current ? 'saved' : 'idle')
      })
  }

  useEffect(() => {
    if (!microphone) return
    const off = onNativeAudio((event) => {
      if (event.tipo === 'gravando') {
        recoveryAllowed.current = false
        take.current = event.gravacao ?? null
        return setVoice('recording')
      }
      if (event.tipo === 'audio' && event.recuperado) {
        if (!recoveryAllowed.current || event.tabId !== tab.id) return
        recoveryAllowed.current = false
        take.current = event.gravacao ?? null
      }
      if (event.gravacao !== undefined && event.gravacao !== take.current) return
      if (event.tipo === 'nivel') return level.current?.(event.valor)
      if (event.tipo !== 'audio') {
        take.current = null
        setVoice('idle')
        if (event.tipo === 'curto') setComposerError('Gravação curta demais: toque no microfone, fale e toque em ✓ para transcrever.')
        if (event.tipo === 'erro') setComposerError(event.mensagem)
        return
      }
      if (audioDraft.current) return
      audioDraft.current = { base64: event.base64, mime: event.mime }
      if (event.rascunho) setVoice('saved')
      else transcribePending()
    })
    const recover = (): void => { if (recoveryAllowed.current) recoverAudio(tab.projectId, tab.id) }
    window.addEventListener('kora-audio-pendente', recover)
    recover()
    return () => {
      window.removeEventListener('kora-audio-pendente', recover)
      off()
      stopRecording(false)
      discardAudio()
      audioDraft.current = null
      transcription.current?.abort()
      transcription.current = null
    }
  }, [microphone])
  // Cancelar na transcrição fecha o pedido; o PC percebe e apaga o trabalho no Transcritor, que para de processar.
  const cancelVoice = (): void => {
    recoveryAllowed.current = false
    if (voice === 'recording') stopRecording(false)
    discardAudio()
    audioDraft.current = null
    take.current = null
    transcription.current?.abort()
    transcription.current = null
    setVoice('idle')
  }

  const keys = (data: string): void => {
    void send({ type: 'keys', tabId: tab.id, data }).catch((error: Error) => onError(error.message))
  }
  const redraw = (): void => {
    setMoreKeys(false)
    void send({ type: 'redraw', tabId: tab.id })
      .then(() => new Promise((resolve) => setTimeout(resolve, REDRAW_SETTLE_MS)))
      .then(() => setRedraws((count) => count + 1), (error: Error) => onError(error.message))
  }
  // Igual ao Ctrl+V com print no PC: a imagem vira arquivo no PC e o caminho vai na mensagem, que o Claude e o
  // Codex anexam.
  const attach = async (files: File[]): Promise<void> => {
    setComposerError(null)
    // O PC aceita até 10 por mensagem (MobileCommandSchema); passar disso só falharia no envio, depois de subir tudo.
    if (images.length + uploading + files.length > 10) {
      setComposerError('Anexe no máximo 10 arquivos por mensagem.')
      return
    }
    for (const file of files) {
      setUploading((count) => count + 1)
      try {
        const attached = await uploadAttachment(file)
        setImages((list) => [...list, attached])
      } catch (error) {
        setComposerError(error instanceof Error ? error.message : String(error))
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }
  const kind = tab.agent?.kind
  useEffect(() => {
    if (kind !== 'claude' || skills !== null || !draft.startsWith('/') || !connected) return
    setSkills([])
    void api<{ name: string; description: string }[]>(`skills?tab=${encodeURIComponent(tab.id)}`).then(setSkills, () => setSkills([]))
  }, [kind, skills, draft, connected, tab.id])
  const slash = ((): { label: string; description: string; fill: string }[] => {
    if (!kind || !draft.startsWith('/') || draft.includes('\n')) return []
    const commands = agentCommands(kind)
    const withArg = draft.match(/^(\/\S+)\s+(\S*)$/)
    if (withArg) {
      const command = commands.find((c) => c.name === withArg[1])
      return (command?.options ?? []).filter((o) => o.startsWith(withArg[2]!) && o !== withArg[2]).map((o) => ({ label: o, description: '', fill: `${command!.name} ${o}` }))
    }
    if (/\s/.test(draft)) return []
    const typed = draft.toLowerCase()
    const all = [
      ...commands.map((c) => ({ label: c.name, description: c.interactive || kind !== 'claude' ? `${c.description} · abre no terminal` : c.description, fill: `${c.name} ` })),
      ...(skills ?? []).map((s) => ({ label: `/${s.name}`, description: s.description, fill: `/${s.name} ` }))
    ]
    return all.filter((entry) => entry.label.toLowerCase().startsWith(typed) && entry.fill.trim() !== draft.trim()).slice(0, 30)
  })()
  const removeImage = (path: string): void => setImages((list) => list.filter((image) => image.path !== path))
  const clear = (): void => {
    setDraft('')
    setImages([])
    setComposerError(null)
  }
  const submit = (): void => {
    const text = draft.trim()
    if ((!text && images.length === 0) || uploading) return
    if (text.length > SEND_TEXT_MAX) {
      const count = (n: number): string => n.toLocaleString('pt-BR')
      setComposerError(`A mensagem tem ${count(text.length)} caracteres e o limite é ${count(SEND_TEXT_MAX)}. Tire ${count(text.length - SEND_TEXT_MAX)} para enviar.`)
      return
    }
    const sent = { text: draft, images }
    setComposerError(null)
    setSending(true)
    // O campo esvazia no toque, não na resposta do PC: quem sai e volta antes dela não acha o texto pronto para
    // mandar de novo. Se o envio falha, o texto volta, a menos que a pessoa já tenha escrito outro.
    setDraft('')
    setImages([])
    drafts.delete(tab.id)
    const files = images.filter((item) => item.name !== undefined).map((item) => item.path)
    const pictures = images.filter((item) => item.name === undefined).map((item) => pathForPrompt(item.path))
    void send({ type: 'send', tabId: tab.id, text, images: pictures, files })
      .then(() => { if (reading && kind && opensTerminal(kind, text)) onTerminal?.() })
      .catch((error: Error) => {
        if (!drafts.has(tab.id)) {
          drafts.set(tab.id, sent)
          if (!storedDraftTexts()[tab.id]) storeDraftText(tab.id, sent.text)
        }
        setDraft((current) => current || sent.text)
        setImages((current) => (current.length > 0 ? current : sent.images))
        setComposerError(error.message)
      })
      .finally(() => setSending(false))
  }

  if (!live) return <></>
  const elsewhere = holder !== null && holder !== device
  return <>
    {reading ? <ReadingView tab={tab} connected={connected} connection={connection} feed={feed} modelSheet={modelSheet} onModelSheet={(open) => onModelSheet?.(open)} onError={onError} onTerminal={() => onTerminal?.()} onInterrupt={() => keys('\x1b')} onSend={(text, picker) => void send({ type: 'send', tabId: tab.id, text, images: [], files: [] }).then(() => { if (picker) onTerminal?.() }, (error: Error) => onError(error.message))} /> : <>
    {elsewhere && <button className="size-banner" onClick={() => void send({ type: 'attach', tabId: tab.id, ...wanted.current() }).catch((error: Error) => onError(error.message))}>
      {holder === DESKTOP ? 'Em uso no PC, no tamanho dele.' : 'Em uso em outro celular.'} Toque para ajustar a este celular.
    </button>}
    <div className="terminal-area">
      <div className="terminal-mount" ref={mount} />
      {hydrating && <SkeletonTerminal label="Abrindo a conversa…" />}
    </div>
    {moreKeys && <nav className="terminal-keys more-keys" aria-label="Mais teclas do terminal">
      {MORE_KEYS.map(([label, data]) => <button disabled={!connected} key={label} onClick={() => keys(data)}>{label}</button>)}
      <button disabled={!connected} onClick={redraw}>Redesenhar</button>
    </nav>}
    <nav className="terminal-keys" aria-label="Teclas do terminal">
      {KEYS.map(([label, data]) => <button disabled={!connected} key={label} onClick={() => keys(data)}>{label}</button>)}
      <button className="more-keys-toggle" aria-label="Mais teclas" aria-expanded={moreKeys} onClick={() => setMoreKeys((open) => !open)}>⋯</button>
    </nav>
    </>}
    {(() => {
      const ready = !sending && uploading === 0 && voice === 'idle' && connected && (draft.trim() !== '' || images.length > 0)
      const thumbs = (images.length > 0 || uploading > 0) && <div className="composer-images" aria-label="Anexos">
        {images.map((image) => image.name !== undefined
          ? <figure key={image.path} className="attached-file" aria-label={`Arquivo anexado: ${image.name}`}>
            <Icon name="arquivo" />
            <figcaption>{image.name}</figcaption>
            <button type="button" className="remove-image" aria-label={`Remover ${image.name}`} onClick={() => removeImage(image.path)}><Icon name="fechar" /></button>
          </figure>
          : <figure key={image.path}>
            {image.preview ? <img src={image.preview} alt="Imagem anexada" /> : <Icon name="imagem" />}
            <button type="button" className="remove-image" aria-label="Remover imagem" onClick={() => removeImage(image.path)}><Icon name="fechar" /></button>
          </figure>)}
        {uploading > 0 && <figure className="uploading" aria-label="Enviando anexo ao PC"><span /></figure>}
      </div>
      // Caixa única, como no app do Claude e do ChatGPT: miniaturas e texto dentro, imagem e enviar embaixo.
      // O rascunho de áudio vale enquanto este chat está aberto, inclusive com o app em segundo plano.
      return <form className="composer" data-no-swipe data-swipe-lock={voice === 'idle' ? undefined : ''} onSubmit={(event) => { event.preventDefault(); submit() }}>
        {slash.length > 0 && <ul className="slash-menu" role="listbox" aria-label="Comandos">
          {slash.map((entry) => <li key={entry.label}><button type="button" role="option" aria-selected={false} onMouseDown={(event) => event.preventDefault()} onClick={() => { setDraft(entry.fill); field.current?.focus() }}>
            <strong>{entry.label}</strong>{entry.description && <small>{entry.description}</small>}
          </button></li>)}
        </ul>}
        <input ref={picker} type="file" multiple hidden aria-label="Escolher arquivo" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void attach(files) }} />
        <div className="composer-box">
          {composerError && <p role="alert" className="composer-error"><Icon name="alerta" /><span>{composerError}</span><button type="button" aria-label="Dispensar aviso" onClick={() => setComposerError(null)}><Icon name="fechar" /></button></p>}
          {thumbs}
          <textarea ref={field} aria-label="Mensagem para a sessão" placeholder="Mensagem para a sessão" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            // Teclado físico ou com Ctrl: Ctrl+Enter envia, Enter sozinho segue quebrando a linha.
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (voice === 'idle') submit()
          }} />
          {/* Ditando, a linha vira descartar, ondas e transcrever: anexar e enviar saem para não mandar a mensagem no meio. */}
          {voice === 'idle' ? <div className="composer-actions">
            <div className="composer-tools">
              <button type="button" className="attach-button" aria-label="Anexar arquivo" disabled={!connected} onClick={() => picker.current?.click()}><Icon name="novaAba" /></button>
              {(draft !== '' || images.length > 0) && <button type="button" className="clear-draft" aria-label="Limpar mensagem" onClick={clear}><Icon name="excluir" /></button>}
            </div>
            <div className="composer-send">
              {microphone && <button type="button" className="mic-button" aria-label="Gravar áudio" disabled={!connected}
                onClick={() => { recoveryAllowed.current = false; setComposerError(null); startRecording(tab.projectId, tab.id) }}>
                <Icon name="microfone" />
              </button>}
              <button className={`send-button ${ready ? 'ready' : ''}`} aria-label="Enviar" disabled={!ready}><Icon name="setaCima" /></button>
            </div>
          </div> : <div className="composer-actions dictating">
            <button type="button" className="voice-cancel" aria-label={voice === 'recording' || voice === 'saved' ? 'Descartar gravação' : 'Cancelar transcrição'} onClick={cancelVoice}><Icon name="fechar" /></button>
            {voice === 'recording'
              ? <VoiceMeter listen={listenLevel} />
              : voice === 'saved' ? <p className="voice-status" role="status">Áudio guardado neste chat</p>
                : <p className="voice-status" role="status"><span className="mic-spinner" />Transcrevendo no PC…</p>}
            {voice === 'saved' && <button type="button" className="voice-confirm" aria-label="Transcrever áudio guardado" disabled={!connected} onClick={transcribePending}><Icon name="ok" /></button>}
            {voice === 'recording' && <button type="button" className="voice-confirm" aria-label="Parar e transcrever" onClick={() => { setVoice('transcribing'); stopRecording(true) }}><Icon name="ok" /></button>}
          </div>}
        </div>
      </form>
    })()}
  </>
}
