import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

// O rollout de uma conversa do Codex fica em ~/.codex/sessions/AAAA/MM/DD/rollout-<data>-<threadId>.jsonl;
// a data é a do início da conversa, então uma retomada antiga continua no arquivo da pasta antiga.
// Achado uma vez, o caminho fica guardado. Não achado (o Codex cria o rollout junto com o lock, pode
// ser uma corrida), a busca só se repete depois de missRetryMs, para não varrer a pasta a cada evento.
export function createRolloutFinder(sessionsDir: string, missRetryMs = 3000, now = Date.now): (threadId: string) => string | null {
  const found = new Map<string, string>()
  const missedAt = new Map<string, number>()
  return (threadId) => {
    const hit = found.get(threadId)
    if (hit && existsSync(hit)) return hit
    const missed = missedAt.get(threadId)
    if (missed !== undefined && now() - missed < missRetryMs) return null
    const suffix = `-${threadId}.jsonl`
    let entries: string[] = []
    try {
      entries = readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' })
    } catch {
      // Pasta ainda não existe: Codex nunca usado nesta máquina.
    }
    const rel = entries.find((e) => e.endsWith(suffix))
    if (!rel) {
      missedAt.set(threadId, now())
      return null
    }
    const file = join(sessionsDir, rel)
    found.set(threadId, file)
    missedAt.delete(threadId)
    return file
  }
}

// ~/.claude/projects/<pasta>/<sessão>.jsonl. As subpastas de cada sessão (subagentes, resultados de ferramenta)
// mudam o tempo todo enquanto ele trabalha e não dizem nada sobre o fim do turno.
export const isClaudeTranscript = (name: string): boolean =>
  /^[^\\/]+[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name)

// Observa as pastas onde o Claude e o Codex deixam rastro (sessão por pid, locks, rollouts). Pasta que ainda não
// existe (agente nunca usado) é tentada de novo a cada retryMs; watcher que falha (pasta apagada) também volta.
export interface WatchTarget {
  dir: string
  recursive: boolean
  // Nome relativo à pasta vigiada; sem filtro (ou sem nome no evento), qualquer mudança dispara.
  accept?(name: string): boolean
}

export class FolderWatch {
  private readonly watchers = new Map<string, FSWatcher>()
  private retry?: NodeJS.Timeout

  constructor(
    private readonly targets: WatchTarget[],
    private readonly onChange: () => void,
    private readonly retryMs = 3000
  ) {}

  start(): void {
    this.attach()
    this.retry = setInterval(() => this.attach(), this.retryMs)
  }

  private attach(): void {
    for (const { dir, recursive, accept } of this.targets) {
      if (this.watchers.has(dir) || !existsSync(dir)) continue
      try {
        const watcher = watch(dir, { recursive }, (_event, name) => {
          if (!accept || !name || accept(name)) this.onChange()
        })
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
