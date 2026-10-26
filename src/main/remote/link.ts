import type { TLSSocket } from 'node:tls'
import { WebSocket, createWebSocketStream } from 'ws'
import { relayHeaders } from '../../../relay/auth'
import type { Identity } from './identity'
import { openEnvelope, peerFingerprint } from './envelope'

// O lado do PC no relay: mantém a conexão de controle aberta e, a cada celular que chega, abre a conexão de dados daquela
// sessão e o envelope com ele. Cai a rede, o relay reinicia ou o PC volta da suspensão: reconecta sozinho, para sempre,
// com espera crescente até um teto. Quem está longe por dias não depende de ninguém apertar nada no PC.

export type LinkState = 'conectando' | 'conectado' | 'reconectando' | 'parado'
export interface LinkStatus { state: LinkState; since: number; error: string | null }

export interface LinkOptions {
  // wss://kora-sync.eduardom.com.br
  url: string
  identity: Identity
  // X-Kora-Client: sistema e versão, para o dono do relay saber o que está conectado (ex.: "windows/10.0.26100 kora/0.1.34").
  client?: string
  accepts(fingerprint: string): boolean
  deliver(socket: TLSSocket, fingerprint: string): void
  onStatus?(status: LinkStatus): void
  // A cada conexão de controle aberta (inclusive depois de cair): é quando o relay precisa saber dos celulares de novo.
  onConnected?(): void
  minDelayMs?: number
  maxDelayMs?: number
  // O relay manda ping a cada 25 s; sem ping por este tempo, a conexão está morta mesmo sem o sistema ter percebido.
  silenceMs?: number
  handshakeMs?: number
}

const MIN_DELAY_MS = 1_000
const MAX_DELAY_MS = 60_000
const SILENCE_MS = 70_000
const HANDSHAKE_MS = 15_000
const REQUEST_MS = 15_000

export class RelayLink {
  private control: WebSocket | null = null
  private readonly pending = new Set<WebSocket>()
  private retry: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private attempts = 0
  private nextRequest = 1
  private readonly requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private running = false
  private current: LinkStatus = { state: 'parado', since: Date.now(), error: null }

  constructor(private readonly options: LinkOptions) {}

  get status(): LinkStatus { return this.current }

  start(): void {
    if (this.running) return
    this.running = true
    this.connect()
  }

  stop(): void {
    this.running = false
    this.clearTimers()
    this.control?.terminate()
    this.control = null
    for (const data of this.pending) data.terminate()
    this.pending.clear()
    this.failRequests('O acesso fora de casa foi desligado.')
    this.report('parado', null)
  }

  // Pedido ao relay pela conexão de controle (registrar os celulares, admin). Sem conexão, falha na hora.
  request<T = unknown>(body: Record<string, unknown>): Promise<T> {
    const socket = this.control
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Sem conexão com o servidor do Kora.'))
    const id = this.nextRequest++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error('O servidor do Kora não respondeu.'))
      }, REQUEST_MS)
      this.requests.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      socket.send(JSON.stringify({ ...body, id }))
    })
  }

  private failRequests(message: string): void {
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.requests.clear()
  }

  private headers(path: string): Record<string, string> {
    return { ...relayHeaders(this.options.identity, path), ...(this.options.client ? { 'x-kora-client': this.options.client } : {}) }
  }

  // Rede trocou ou o PC voltou da suspensão: não espera a próxima tentativa nem o ping que não vai chegar.
  reconnectNow(): void {
    if (!this.running) return
    this.attempts = 0
    this.clearTimers()
    this.control?.terminate()
    this.control = null
    this.failRequests('A conexão com o servidor do Kora caiu.')
    this.connect()
  }

  private connect(): void {
    if (!this.running) return
    this.report(this.attempts === 0 ? 'conectando' : 'reconectando', this.current.error)
    const path = `/s/${this.options.identity.fingerprint}`
    const socket = new WebSocket(`${this.options.url}${path}`, { headers: this.headers(path), handshakeTimeout: this.options.handshakeMs ?? HANDSHAKE_MS })
    this.control = socket
    socket.on('open', () => {
      this.attempts = 0
      this.report('conectado', null)
      this.listen()
      this.options.onConnected?.()
    })
    socket.on('ping', () => this.listen())
    socket.on('message', (message) => {
      const parsed = (() => { try { return JSON.parse(String(message)) as { sessao?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown } } catch { return null } })()
      if (!parsed) return
      if (typeof parsed.sessao === 'string' && /^[0-9a-f]{32}$/.test(parsed.sessao)) return this.session(parsed.sessao)
      const pending = typeof parsed.id === 'number' ? this.requests.get(parsed.id) : undefined
      if (!pending) return
      this.requests.delete(parsed.id as number)
      clearTimeout(pending.timer)
      if (parsed.ok === true) pending.resolve(parsed.result)
      else pending.reject(new Error(typeof parsed.error === 'string' ? parsed.error : 'O servidor do Kora recusou o pedido.'))
    })
    socket.on('unexpected-response', (_request, response) => {
      // 403: a assinatura está certa, mas este PC não está numa conta ativa (saiu, foi removido ou a conta foi
      // bloqueada). Insistir não muda nada: espera o teto entre as tentativas.
      if (response.statusCode === 403) this.attempts = Math.max(this.attempts, 16)
      this.current = {
        ...this.current,
        error: response.statusCode === 403 ? 'Este PC não está ligado a uma conta ativa do Kora.'
          : response.statusCode === 404 ? 'O servidor do Kora recusou este PC.'
          : `O servidor do Kora respondeu ${response.statusCode}.`
      }
      socket.terminate()
    })
    socket.on('error', (error) => { if (!this.current.error || this.current.state === 'conectado') this.current = { ...this.current, error: error.message } })
    socket.on('close', () => {
      if (this.control !== socket) return
      this.control = null
      this.failRequests('A conexão com o servidor do Kora caiu.')
      if (this.watchdog) clearTimeout(this.watchdog)
      this.schedule()
    })
  }

  private listen(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    const socket = this.control
    this.watchdog = setTimeout(() => { if (this.control === socket) socket?.terminate() }, this.options.silenceMs ?? SILENCE_MS)
  }

  private schedule(): void {
    if (!this.running) return
    const min = this.options.minDelayMs ?? MIN_DELAY_MS
    const max = this.options.maxDelayMs ?? MAX_DELAY_MS
    // Espera crescente com sorteio: depois de uma queda do relay, os PCs não voltam todos no mesmo instante.
    const delay = Math.min(max, min * 2 ** this.attempts) * (0.5 + Math.random() / 2)
    this.attempts++
    this.report('reconectando', this.current.error)
    this.retry = setTimeout(() => { this.retry = null; this.connect() }, delay)
  }

  private session(id: string): void {
    const path = `/s/${this.options.identity.fingerprint}/${id}`
    const data = new WebSocket(`${this.options.url}${path}`, { headers: this.headers(path), handshakeTimeout: this.options.handshakeMs ?? HANDSHAKE_MS })
    data.on('error', () => {})
    this.pending.add(data)
    openEnvelope(createWebSocketStream(data), this.options.identity, this.options.accepts)
      .then((socket) => {
        this.pending.delete(data)
        if (this.running) this.options.deliver(socket, peerFingerprint(socket)!)
        else socket.destroy()
      }, () => {
        this.pending.delete(data)
        data.terminate()
      })
  }

  private clearTimers(): void {
    if (this.retry) clearTimeout(this.retry)
    if (this.watchdog) clearTimeout(this.watchdog)
    this.retry = null
    this.watchdog = null
  }

  private report(state: LinkState, error: string | null): void {
    if (this.current.state === state && this.current.error === error) return
    this.current = { state, since: state === this.current.state ? this.current.since : Date.now(), error }
    this.options.onStatus?.(this.current)
  }
}
