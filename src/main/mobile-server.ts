import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { createSocket } from 'node:dgram'
import { hostname, networkInterfaces } from 'node:os'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import QRCode from 'qrcode'
import { z } from 'zod'
import { DeviceNameSchema, FileSaveSchema, MobileCommandSchema, type MobilePairing, type MobileStatus, type TerminalSizeEvent } from '../shared/mobile'
import { MobilePairingStore } from './mobile-pairing'
import { MAX_PASTED_IMAGE_BYTES, savePastedImage } from './pasted-image'
import { ConflictError } from './files'
import type { MobileRuntime } from './mobile-runtime'
import { TranscriberUnavailableError, type Transcribe } from './transcriber'

export function isLocalAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '')
  if (ip === '::1') return true
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
  return parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 169 && parts[1] === 254)
}

export function localAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((interfaces) =>
    (interfaces ?? []).filter((i) => i.family === 'IPv4' && !i.internal && isLocalAddress(i.address)).map((i) => i.address)
  ))]
}

// Adaptador de VM (VMware, Hyper-V, WSL) também tem endereço de rede local, mas o celular não o alcança. O endereço
// certo é o da rota padrão: connect em UDP não manda pacote, só pergunta ao sistema por qual interface sairia.
async function routedAddress(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const socket = createSocket('udp4')
    const finish = (address: string | null): void => { socket.close(); resolvePromise(address) }
    socket.once('error', () => finish(null))
    socket.connect(53, '1.1.1.1', () => finish(socket.address().address))
  })
}

export async function preferredAddress(): Promise<string | null> {
  const local = localAddresses()
  const routed = await routedAddress()
  return routed && local.includes(routed) ? routed : local[0] ?? null
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm'
}
const PDFJS_DIRS = new Set(['wasm', 'cmaps', 'standard_fonts', 'iccs'])
const AUDIO_EXTENSIONS: Record<string, string> = { 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }
// O app para de gravar em 15 minutos, uns 3 MB em Opus a 24 kbps. O corpo tem 60 s para chegar (requestTimeout):
// 8 MB ainda sobem num Wi-Fi de 1 Mbps.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
// Link de leitura dos arquivos de um projeto, para o HTML aberto no celular carregar o CSS e as imagens dele por
// caminho relativo. Vale por pouco tempo e só lê: a página roda isolada (sandbox) e não recebe o pareamento.
const RAW_LINK_MS = 30 * 60_000
const PairSchema = z.object({ code: z.string().min(1).max(100), name: z.string().max(60) })
const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
const sendEvent = (response: ServerResponse, event: string, body: unknown): void => {
  if (response.writableLength > 1_048_576) { response.destroy(); return }
  response.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`)
}

export class MobileServer {
  readonly pairing: MobilePairingStore
  private server: Server | null = null
  private port = 0
  private started = Date.now()
  private readonly clients = new Set<{ device: string; response: ServerResponse }>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // base: a pasta do arquivo aberto. O link só lê dali para baixo, e de quem pediu (some ao desvincular o celular).
  private readonly rawLinks = new Map<string, { projectId: string; base: string; device: string; until: number }>()

  constructor(private readonly options: {
    configFile: string
    rendererDir: string
    devUrl?: string
    devAssetRoots?: string[]
    // Pasta com o APK do app Android e a versão dele (scripts/android-apk.ts), levados no instalador do PC.
    androidDir?: string
    // Onde o print mandado pelo celular vira arquivo: a mesma pasta do Ctrl+V com imagem no PC.
    imageDir?: string
    // O áudio gravado no celular fica aqui só enquanto o Transcritor lê.
    audioDir?: string
    transcribe?: Transcribe
    // Decodificadores, fontes e mapas que o pdf.js do celular busca por URL (scripts/pdfjs-assets.ts).
    pdfjsDir?: string
    // O app do celular mostra "(Dev)" no nome: os dois Kora do mesmo PC têm o mesmo nome de computador.
    edition?: 'dev' | 'prod'
    runtime: MobileRuntime
    changed(): void
    // Pareou, renomeou, desvinculou, abriu ou fechou o Kora no celular: a tela do PC atualiza na hora.
    statusChanged?(status: MobileStatus): void
    port?: number
  }) {
    this.pairing = new MobilePairingStore(options.configFile)
  }

  status(): MobileStatus {
    return {
      enabled: this.server !== null,
      network: this.server !== null && localAddresses().length > 0,
      devices: this.pairing.devices.map((device) => ({ ...device, online: this.online(device.id) }))
    }
  }

  // Reconectar (trocar de rede, recarregar a página) leva um instante; o aviso de queda espera o prazo da saída.
  private online(device: string): boolean {
    return this.disconnectTimers.has(device) || [...this.clients].some((client) => client.device === device)
  }

  private notify(): void { this.options.statusChanged?.(this.status()) }

  // Cookie não separa por porta: o Kora instalado e o Dev no mesmo PC mandariam o mesmo cookie e um apagaria o
  // pareamento do outro. Com o id no nome, cada um lê o seu.
  private cookieName(): string { return `kora-device-${this.pairing.serverId}` }

  private deviceToken(header: string): string {
    const cookies = new Map(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const at = part.indexOf('=')
      return [at < 0 ? part : part.slice(0, at), at < 0 ? '' : part.slice(at + 1)] as const
    }))
    // kora-device: o nome de antes do id, para quem já tinha pareado não precisar parear de novo.
    return cookies.get(this.cookieName()) ?? cookies.get('kora-device') ?? ''
  }

  async start(): Promise<MobileStatus> {
    if (this.server) return this.status()
    const server = createServer((req, res) => { void this.handle(req, res) })
    // Print grande num Wi-Fi fraco leva mais de 10 s para subir. Conexão parada fica aberta 30 s: com os 5 s
    // padrão, o celular reaproveitava uma conexão que o PC acabara de fechar e a imagem falhava na primeira vez.
    server.requestTimeout = 60_000
    server.keepAliveTimeout = 30_000
    server.headersTimeout = 31_000
    await new Promise<void>((resolvePromise, reject) => {
      const failed = (error: NodeJS.ErrnoException): void => reject(error.code === 'EADDRINUSE'
        ? new Error('Outro Kora aberto neste PC já está com a conexão do celular ligada. Desligue nele para ligar aqui.')
        : error)
      server.once('error', failed)
      server.listen(this.options.port ?? 43127, '0.0.0.0', () => {
        server.off('error', failed)
        resolvePromise()
      })
    })
    this.server = server
    this.port = (server.address() as { port: number }).port
    this.started = Date.now()
    this.pairing.setEnabled(true)
    if (this.options.audioDir) await this.dropStaleAudio(this.options.audioDir)
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.response.write(': heartbeat\n\n')
    }, 15_000)
    this.options.changed()
    this.notify()
    return this.status()
  }

  async stop(): Promise<MobileStatus> {
    this.pairing.setEnabled(false)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer)
    this.disconnectTimers.clear()
    for (const client of this.clients) {
      client.response.end()
    }
    this.clients.clear()
    for (const device of this.pairing.devices) this.options.runtime.leave(device.id)
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
    this.options.changed()
    this.notify()
    return this.status()
  }

  async invite(): Promise<MobilePairing> {
    const address = this.server ? await preferredAddress() : null
    if (!address) throw new Error(this.server ? 'Conecte o PC ao Wi-Fi ou ao cabo de rede para conectar o celular.' : 'Ative a conexão antes.')
    const invitation = this.pairing.invite()
    const link = `http://${address}:${this.port}/#pair=${invitation.code}`
    return { url: link, qr: await QRCode.toDataURL(link, { width: 256, margin: 2, errorCorrectionLevel: 'M' }), expiresAt: new Date(invitation.until).toISOString() }
  }

  revoke(id: string): MobileStatus {
    this.pairing.revoke(id)
    this.options.runtime.leave(id)
    for (const [token, link] of this.rawLinks) if (link.device === id) this.rawLinks.delete(token)
    clearTimeout(this.disconnectTimers.get(id))
    this.disconnectTimers.delete(id)
    for (const client of this.clients) if (client.device === id) {
      sendEvent(client.response, 'revoked', {})
      client.response.end()
    }
    this.options.changed()
    this.notify()
    return this.status()
  }

  rename(id: string, name: string): MobileStatus {
    this.pairing.rename(id, DeviceNameSchema.parse(name))
    this.notify()
    return this.status()
  }

  publishState(): void {
    for (const client of this.clients) sendEvent(client.response, 'state', this.options.runtime.snapshot())
  }

  publishData(id: string, data: string, sequence: number): void {
    for (const client of this.clients) if (this.options.runtime.viewing(client.device, id)) sendEvent(client.response, 'terminal', { id, data, sequence })
  }

  publishSize(event: TerminalSizeEvent): void {
    for (const client of this.clients) sendEvent(client.response, 'size', event)
  }

  private rawLink(projectId: string, rel: string, device: string): string {
    const now = Date.now()
    for (const [token, link] of this.rawLinks) if (link.until < now) this.rawLinks.delete(token)
    const token = randomBytes(18).toString('base64url')
    const parts = rel.split(/[\\/]/).filter(Boolean)
    this.rawLinks.set(token, { projectId, base: parts.slice(0, -1).join('/'), device, until: now + RAW_LINK_MS })
    return `/raw/${token}/${parts.map(encodeURIComponent).join('/')}`
  }

  private raw(pathname: string, response: ServerResponse): void {
    const [, , token = '', ...encoded] = pathname.split('/')
    const link = this.rawLinks.get(token)
    if (!link || link.until < Date.now()) return json(response, 403, { error: 'Link vencido. Abra o arquivo de novo.' })
    let parts: string[]
    try {
      parts = encoded.map(decodeURIComponent).flatMap((part) => part.split(/[\\/]/)).filter(Boolean)
    } catch {
      return json(response, 400, { error: 'Endereço inválido.' })
    }
    // Um HTML do projeto roda com scripts: não lê nada fora da pasta dele nem arquivo oculto (.env, .git).
    const inside = link.base === '' || parts.join('/').startsWith(`${link.base}/`)
    if (!inside || parts.some((part) => part.startsWith('.'))) return json(response, 403, { error: 'Fora da pasta deste arquivo.' })
    let file: string
    try {
      file = this.options.runtime.filePath(link.projectId, parts.join('/'))
    } catch {
      return json(response, 404, { error: 'Arquivo não encontrado.' })
    }
    // sandbox: o HTML do projeto roda sem a origem do Kora, então não alcança a API com o cookie do celular.
    response.setHeader('content-security-policy', "sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors 'self'")
    // Isolada, a página não tem origem: módulo de script, fonte e fetch dos arquivos dela só carregam com CORS aberto.
    // O link já é a chave; o CORS não dá acesso a mais nada.
    response.setHeader('access-control-allow-origin', '*')
    response.writeHead(200, { 'content-type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream' })
    createReadStream(file).on('error', () => response.destroy()).pipe(response)
  }

  // Arquivos da própria biblioteca, iguais para todos: sem pareamento, mas só um nome de arquivo dentro das pastas dela.
  private async pdfjs(pathname: string, response: ServerResponse): Promise<void> {
    const [, , dir = '', name = '', ...rest] = pathname.split('/')
    if (!this.options.pdfjsDir || !PDFJS_DIRS.has(dir) || rest.length > 0 || !/^[\w.-]+$/.test(name) || name.startsWith('.')) {
      return json(response, 404, { error: 'Arquivo não encontrado.' })
    }
    const content = await readFile(join(this.options.pdfjsDir, dir, name)).catch(() => null)
    if (!content) return json(response, 404, { error: 'Arquivo não encontrado.' })
    response.writeHead(200, { 'content-type': contentTypes[extname(name).toLowerCase()] ?? 'application/octet-stream' })
    response.end(content)
  }

  // Imagem chega crua (o corpo é o arquivo), sem passar pelo limite de 64 KB do JSON.
  private async image(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const mime = request.headers['content-type']?.split(';')[0]?.trim() ?? ''
    if (!this.options.imageDir) return json(response, 404, { error: 'Este Kora não recebe imagens.' })
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) return json(response, 415, { error: 'Envie a imagem como PNG, JPEG, GIF ou WebP.' })
    const chunks: Buffer[] = []
    let size = 0
    // Passou do limite, o resto é lido e descartado: responder no meio do envio derruba a conexão, e o celular
    // veria "falha de rede" em vez do aviso de tamanho.
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size <= MAX_PASTED_IMAGE_BYTES) chunks.push(chunk as Buffer)
    }
    console.info(`[kora] imagem do celular: ${size} bytes, ${mime}`)
    if (size > MAX_PASTED_IMAGE_BYTES) return json(response, 413, { error: 'Imagem grande demais: o limite é 20 MB.' })
    json(response, 200, { path: savePastedImage(this.options.imageDir, Buffer.concat(chunks), mime) })
  }

  // O Kora instalado e o Dev usam a mesma pasta temporária: só sai o que nenhuma transcrição em andamento usa.
  private async dropStaleAudio(dir: string): Promise<void> {
    for (const name of await readdir(dir).catch(() => [])) {
      const file = join(dir, name)
      const { mtimeMs } = await stat(file).catch(() => ({ mtimeMs: Date.now() }))
      if (Date.now() - mtimeMs > 3_600_000) await rm(file, { force: true }).catch(() => {})
    }
  }

  private async audio(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { audioDir, transcribe } = this.options
    if (!audioDir || !transcribe) return json(response, 404, { error: 'Este Kora não transcreve áudio.' })
    const extension = AUDIO_EXTENSIONS[request.headers['content-type']?.split(';')[0]?.trim() ?? '']
    if (!extension) return json(response, 415, { error: 'Envie o áudio como OGG, WebM, M4A, AAC, MP3 ou WAV.' })
    // A resposta fecha antes do fim quando o celular desiste (tela apagada, rede caiu, cancelou): o Transcritor para
    // junto. Registrado antes de ler o corpo, para não perder a desistência que acontece durante o envio.
    const gone = new AbortController()
    response.once('close', () => gone.abort())
    const chunks: Buffer[] = []
    let size = 0
    // Como na imagem: o excesso é lido e descartado para o aviso de tamanho chegar ao celular.
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size <= MAX_AUDIO_BYTES) chunks.push(chunk as Buffer)
    }
    if (size > MAX_AUDIO_BYTES) return json(response, 413, { error: 'Áudio grande demais: o limite é 8 MB.' })
    if (size === 0) return json(response, 400, { error: 'O áudio chegou vazio.' })
    if (gone.signal.aborted) return
    mkdirSync(audioDir, { recursive: true })
    const file = join(audioDir, `fala-${Date.now()}-${randomBytes(4).toString('hex')}.${extension}`)
    // Escrita que falha no meio (disco cheio) também deixa arquivo: entra na mesma limpeza da transcrição.
    const result = await writeFile(file, Buffer.concat(chunks))
      .then(() => transcribe(file, gone.signal))
      .then((text) => ({ text }), (error: unknown) => ({ error }))
    // Cancelado no meio, o Transcritor ainda pode estar com o arquivo aberto até o próximo trecho: no Windows o rm
    // falha com EBUSY. Novas tentativas cobrem esse intervalo; o que sobrar sai na próxima vez que o Kora ligar.
    await rm(file, { force: true, maxRetries: 10, retryDelay: 300 }).catch((error: Error) => console.warn(`[kora] áudio não apagado: ${error.message}`))
    if (gone.signal.aborted) return
    if ('error' in result) {
      const { error } = result
      return json(response, error instanceof TranscriberUnavailableError ? 503 : 502, { error: error instanceof Error ? error.message : 'Falha ao transcrever.' })
    }
    console.info(`[kora] áudio do celular: ${size} bytes, ${result.text.length} caracteres`)
    json(response, 200, { text: result.text })
  }

  private async body(request: IncomingMessage, limit = 65536): Promise<unknown> {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Envie JSON.')
    request.setEncoding('utf8')
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      if (Buffer.byteLength(body) > limit) throw new Error('Pedido muito grande.')
    }
    return JSON.parse(body)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${this.options.devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'${this.options.devUrl ? ' ws: http://localhost:* http://127.0.0.1:*' : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`)
    try {
      const hosts = [...localAddresses(), '127.0.0.1', 'localhost'].map((host) => `${host}:${this.port}`)
      const host = request.headers.host ?? ''
      if (!isLocalAddress(request.socket.remoteAddress ?? '') || !hosts.includes(host)) return json(response, 403, { error: 'Conexão permitida somente pela rede local.' })
      const url = new URL(request.url ?? '/', `http://${host}`)
      // Antes da checagem de origem: o HTML do projeto roda isolado (sandbox), sem origem, e pede o CSS e as imagens
      // dele daqui. O link só lê arquivos e é a chave dele que autoriza, não o cookie do celular.
      if (url.pathname.startsWith('/raw/') && request.method === 'GET') return this.raw(url.pathname, response)
      const origin = request.headers.origin
      if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: 'Origem não autorizada.' })
      if (url.pathname === '/health' && request.method === 'GET') {
        const uptime = Math.floor((Date.now() - this.started) / 1000)
        const hours = Math.floor(uptime / 3600)
        const minutes = Math.floor((uptime % 3600) / 60)
        const human = uptime < 60 ? `${uptime}s` : hours ? `${hours}h ${minutes}m` : `${minutes}m`
        // app e name: o app do celular varre a rede atrás deste endereço e mostra o PC pelo nome.
        return json(response, 200, { app: 'kora', id: this.pairing.serverId, name: hostname(), edition: this.options.edition ?? 'prod', started_at: new Date(this.started).toISOString(), uptime_seconds: uptime, uptime_human: human })
      }
      // Sem pareamento: o app precisa se atualizar mesmo antes de parear de novo, e o APK não tem nada secreto.
      if ((url.pathname === '/app/android.json' || url.pathname === '/app/kora-celular.apk') && request.method === 'GET') {
        const file = this.options.androidDir && resolve(this.options.androidDir, url.pathname.slice(5))
        const content = file ? await readFile(file).catch(() => null) : null
        if (!content) return json(response, 404, { error: 'Este Kora não trouxe o app do celular.' })
        response.writeHead(200, { 'content-type': file!.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/json; charset=utf-8' })
        response.end(content)
        return
      }
      if (url.pathname.startsWith('/pdfjs/') && request.method === 'GET') return await this.pdfjs(url.pathname, response)
      if (url.pathname === '/api/pair' && request.method === 'POST') {
        const { code, name } = PairSchema.parse(await this.body(request))
        const token = this.pairing.pair(code, name)
        response.setHeader('set-cookie', `${this.cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`)
        this.options.changed()
        this.notify()
        return json(response, 200, { ok: true })
      }
      if (url.pathname.startsWith('/api/')) {
        const token = this.deviceToken(request.headers.cookie ?? '')
        const device = this.pairing.authenticate(token)
        if (!device) return json(response, 401, { error: 'Pareie este celular pelo QR code no PC.' })
        if (url.pathname === '/api/state' && request.method === 'GET') return json(response, 200, { deviceId: device, state: this.options.runtime.snapshot() })
        if (url.pathname === '/api/folders' && request.method === 'GET') {
          const path = z.string().max(4096).optional().parse(url.searchParams.get('path') ?? undefined)
          return json(response, 200, await this.options.runtime.folders(path))
        }
        if (url.pathname === '/api/project-icon' && request.method === 'GET') return json(response, 200, { icon: await this.options.runtime.projectIcon(url.searchParams.get('project') ?? '') })
        if (url.pathname === '/api/usage' && request.method === 'GET') return json(response, 200, await this.options.runtime.usage())
        if (url.pathname === '/api/image' && request.method === 'POST') return await this.image(request, response)
        if (url.pathname === '/api/audio' && request.method === 'POST') return await this.audio(request, response)
        if (url.pathname === '/api/files' && request.method === 'GET') {
          return json(response, 200, this.options.runtime.files(url.searchParams.get('project') ?? '', url.searchParams.get('path') ?? ''))
        }
        if (url.pathname === '/api/git' && request.method === 'GET') return json(response, 200, await this.options.runtime.git(url.searchParams.get('project') ?? ''))
        if (url.pathname === '/api/file' && request.method === 'GET') {
          const project = url.searchParams.get('project') ?? ''
          const path = url.searchParams.get('path') ?? ''
          return json(response, 200, { ...this.options.runtime.readFile(project, path), raw: this.rawLink(project, path, device) })
        }
        if (url.pathname === '/api/file-link' && request.method === 'GET') {
          const project = url.searchParams.get('project') ?? ''
          const path = url.searchParams.get('path') ?? ''
          this.options.runtime.filePath(project, path)
          return json(response, 200, { raw: this.rawLink(project, path, device) })
        }
        if (url.pathname === '/api/file' && request.method === 'POST') {
          // O JSON pode dobrar o tamanho do texto (aspas, barras e quebras de linha escapadas).
          const save = FileSaveSchema.parse(await this.body(request, 14 * 1024 * 1024))
          try {
            return json(response, 200, { mtimeMs: this.options.runtime.writeFile(save.projectId, save.path, save.content, save.mtimeMs) })
          } catch (error) {
            if (error instanceof ConflictError) return json(response, 409, { error: 'O arquivo mudou no PC depois que você abriu.', conflict: true })
            throw error
          }
        }
        if (url.pathname === '/api/device') {
          if (request.method === 'DELETE') {
            this.revoke(device)
            response.setHeader('set-cookie', `${this.cookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
            return json(response, 200, {})
          }
          if (request.method === 'POST') this.rename(device, z.object({ name: DeviceNameSchema }).parse(await this.body(request)).name)
          else if (request.method !== 'GET') return json(response, 405, { error: 'Método não permitido.' })
          return json(response, 200, { id: device, name: this.pairing.devices.find((d) => d.id === device)?.name ?? '' })
        }
        if (url.pathname === '/api/sessions' && request.method === 'GET') return json(response, 200, await this.options.runtime.sessions(url.searchParams.get('project') ?? ''))
        if (url.pathname === '/api/snapshot' && request.method === 'GET') {
          const id = url.searchParams.get('tab') ?? ''
          return json(response, 200, await this.options.runtime.snapshotTerminal(id))
        }
        if (url.pathname === '/api/action' && request.method === 'POST') {
          const command = MobileCommandSchema.parse(await this.body(request))
          return json(response, 200, await this.options.runtime.execute(device, command))
        }
        if (url.pathname === '/api/events' && request.method === 'GET') {
          if ([...this.clients].filter((c) => c.device === device).length >= 4) return json(response, 429, { error: 'Muitas conexões deste dispositivo.' })
          const arrived = !this.online(device)
          clearTimeout(this.disconnectTimers.get(device))
          this.disconnectTimers.delete(device)
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' })
          const client = { device, response }
          this.clients.add(client)
          sendEvent(response, 'state', this.options.runtime.snapshot())
          if (arrived) this.notify()
          response.on('close', () => {
            this.clients.delete(client)
            if (!this.server) return
            if (![...this.clients].some((c) => c.device === device)) {
              const timer = setTimeout(() => {
                this.disconnectTimers.delete(device)
                this.options.runtime.leave(device)
                this.notify()
              }, 3000)
              this.disconnectTimers.set(device, timer)
            }
          })
          return
        }
        return json(response, 404, { error: 'Operação não encontrada.' })
      }
      if (request.method !== 'GET') return json(response, 405, { error: 'Método não permitido.' })
      await this.asset(url.pathname === '/' ? '/mobile.html' : url.pathname + url.search, response)
    } catch (error) {
      if (response.headersSent) response.end()
      // Arquivo ou pasta apagados (o agente pode ter mexido): aviso claro, sem o erro do Node com o caminho do PC.
      else if ((error as NodeJS.ErrnoException).code === 'ENOENT') json(response, 404, { error: 'Esse arquivo ou pasta não existe mais no PC: pode ter sido apagado ou renomeado.' })
      else if (error instanceof z.ZodError && error.issues.some((issue) => issue.code === 'too_big' && issue.path[0] === 'content')) json(response, 413, { error: 'Arquivo grande demais para salvar pelo celular.' })
      else json(response, 400, { error: error instanceof z.ZodError ? 'Pedido inválido.' : error instanceof Error ? error.message : 'Falha na operação.' })
    }
  }

  private async asset(path: string, response: ServerResponse): Promise<void> {
    const pathname = path.split('?')[0]!
    if (this.options.devUrl) {
      const fsPath = pathname.startsWith('/@fs/') ? resolve(decodeURIComponent(pathname.slice(5))) : null
      const allowedFs = fsPath !== null && (this.options.devAssetRoots ?? []).some((root) => fsPath.toLowerCase().startsWith(resolve(root).toLowerCase() + sep))
      if (!(allowedFs || pathname === '/mobile.html' || pathname === '/mobile.webmanifest' || pathname === '/mobile-icon.svg' || pathname.startsWith('/src/') || pathname.startsWith('/node_modules/.vite/') || pathname.startsWith('/@vite/') || pathname === '/@react-refresh')) {
        return json(response, 404, { error: 'Arquivo não encontrado.' })
      }
      // Na primeira carga o Vite segura os arquivos até terminar de preparar as dependências (CodeMirror, pdf.js);
      // com a máquina ocupada isso passa de 5 s, e a página do celular não subia.
      const resource = await fetch(new URL(path, this.options.devUrl), { signal: AbortSignal.timeout(30000) })
      response.writeHead(resource.status, { 'content-type': resource.headers.get('content-type') ?? 'text/plain' })
      response.end(Buffer.from(await resource.arrayBuffer()))
      return
    }
    const root = resolve(this.options.rendererDir)
    const file = resolve(root, `.${decodeURIComponent(pathname)}`)
    if (!file.startsWith(root + sep) || !(pathname === '/mobile.html' || pathname === '/mobile.webmanifest' || pathname === '/mobile-icon.svg' || pathname.startsWith('/assets/'))) return json(response, 404, { error: 'Arquivo não encontrado.' })
    try {
      const content = await readFile(file)
      response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' })
      response.end(content)
    } catch {
      json(response, 404, { error: 'Arquivo não encontrado.' })
    }
  }
}
