import type { UpdateStatus } from '../shared/update'

// Atualização pelas Releases do GitHub: consulta ao abrir e de tempos em tempos, baixa sozinha em segundo plano,
// mas só instala quando o usuário manda. Instalar é fechar como no "Sair" (abas viram "Continuar", estado já salvo)
// e o instalador silencioso reabre o app.
export interface UpdateSource {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterOptions {
  source: UpdateSource
  onStatus(status: UpdateStatus): void
  // Encerra os terminais e marca o app como saindo antes do instalador assumir.
  beforeInstall(): void
  log(line: string): void
  now?: () => number
  firstCheckMs?: number
  intervalMs?: number
}

const HOUR = 60 * 60 * 1000

export interface Updates {
  status(): UpdateStatus
  check(): void
  install(): boolean
  stop(): void
}

export function startUpdates(options: UpdaterOptions): Updates {
  const { source } = options
  const now = options.now ?? Date.now
  source.autoDownload = true
  // Sair pelo menu não instala escondido: a versão nova entra quando o usuário clica em "Atualizar agora".
  source.autoInstallOnAppQuit = false
  let status: UpdateStatus = { state: 'idle' }
  const set = (next: UpdateStatus): void => {
    status = next
    options.onStatus(next)
  }
  // Versão já baixada continua valendo: uma consulta nova (manual ou periódica) não esconde o "Atualizar agora".
  const ready = (): boolean => status.state === 'ready'

  source.on('checking-for-update', () => !ready() && set({ state: 'checking' }))
  source.on('update-available', (info) => {
    options.log(`versão ${info.version} disponível, baixando`)
    if (!ready()) set({ state: 'downloading', version: info.version, percent: 0 })
  })
  source.on('download-progress', (progress) => {
    if (status.state === 'downloading') set({ ...status, percent: Math.round(progress.percent) })
  })
  source.on('update-not-available', () => !ready() && set({ state: 'current', checkedAt: now() }))
  source.on('update-downloaded', (info) => {
    options.log(`versão ${info.version} baixada`)
    set({ state: 'ready', version: info.version })
  })
  source.on('error', (err) => {
    options.log(`erro: ${err.message}`)
    if (!ready()) set({ state: 'error', message: err.message })
  })

  const check = (): void => {
    if (status.state === 'checking' || status.state === 'downloading') return
    source.checkForUpdates().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      options.log(`erro ao consultar: ${message}`)
      if (!ready()) set({ state: 'error', message })
    })
  }
  const first = setTimeout(check, options.firstCheckMs ?? 15_000)
  const every = setInterval(check, options.intervalMs ?? 6 * HOUR)
  return {
    status: () => status,
    check,
    install() {
      if (status.state !== 'ready') return false
      options.beforeInstall()
      source.quitAndInstall(true, true)
      return true
    },
    stop() {
      clearTimeout(first)
      clearInterval(every)
    }
  }
}
