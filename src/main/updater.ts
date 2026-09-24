// Atualização pelas Releases do GitHub: baixa sozinha em segundo plano, mas só instala quando o usuário manda.
// Instalar é fechar como no "Sair" (abas viram "Continuar", estado já salvo) e o instalador silencioso reabre o app.
export interface UpdateSource {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterOptions {
  source: UpdateSource
  onReady(version: string): void
  // Encerra os terminais e marca o app como saindo antes do instalador assumir.
  beforeInstall(): void
  log(line: string): void
  firstCheckMs?: number
  intervalMs?: number
}

const HOUR = 60 * 60 * 1000

export interface Updates {
  pending(): string | null
  install(): boolean
  stop(): void
}

export function startUpdates(options: UpdaterOptions): Updates {
  const { source } = options
  source.autoDownload = true
  // Sair pelo menu não instala escondido: a versão nova entra quando o usuário clica em "Atualizar agora".
  source.autoInstallOnAppQuit = false
  let ready: string | null = null
  source.on('update-downloaded', (info) => {
    ready = info.version
    options.log(`versão ${info.version} baixada`)
    options.onReady(info.version)
  })
  source.on('error', (err) => options.log(`erro: ${err.message}`))
  const check = (): void => {
    source.checkForUpdates().catch((err: unknown) => options.log(`erro ao consultar: ${err instanceof Error ? err.message : String(err)}`))
  }
  const first = setTimeout(check, options.firstCheckMs ?? 15_000)
  const every = setInterval(check, options.intervalMs ?? 6 * HOUR)
  return {
    pending: () => ready,
    install() {
      if (!ready) return false
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
