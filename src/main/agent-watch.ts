import { existsSync, watch, type FSWatcher } from 'node:fs'

// Observa as pastas onde o Claude e o Codex deixam rastro (sessão por pid, locks). Pasta que ainda não
// existe (agente nunca usado) é tentada de novo a cada retryMs; watcher que falha (pasta apagada) também volta.
export class FolderWatch {
  private readonly watchers = new Map<string, FSWatcher>()
  private retry?: NodeJS.Timeout

  constructor(
    private readonly targets: { dir: string; recursive: boolean }[],
    private readonly onChange: () => void,
    private readonly retryMs = 3000
  ) {}

  start(): void {
    this.attach()
    this.retry = setInterval(() => this.attach(), this.retryMs)
  }

  private attach(): void {
    for (const { dir, recursive } of this.targets) {
      if (this.watchers.has(dir) || !existsSync(dir)) continue
      try {
        const watcher = watch(dir, { recursive }, () => this.onChange())
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, watcher)
        // A pasta pode ter nascido junto com o arquivo que interessa (primeiro Claude da máquina).
        this.onChange()
      } catch {
        // Sem permissão ou sumiu entre o existsSync e o watch: a próxima volta tenta de novo.
      }
    }
  }

  stop(): void {
    clearInterval(this.retry)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}
