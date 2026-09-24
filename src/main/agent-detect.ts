import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_ID, type AgentSession } from '../shared/agent'
import { descendants, type ProcInfo } from './processes'

export interface DetectorSources {
  claudeSessionsDir: string
  codexLocksDir: string
  listProcesses(): ProcInfo[]
  creationTime(p: ProcInfo): number | null
  lockHolders(file: string): number[]
}

interface CodexLock {
  threadId: string
  file: string
  birthMs: number
}

// O Claude grava ~/.claude/sessions/<pid>.json enquanto o processo roda; o sessionId muda ali
// quando o usuário troca de conversa com /resume dentro dele.
export function claudeSessionForPid(dir: string, pid: number): AgentSession | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8')) as {
      pid?: number
      sessionId?: string
      name?: string
    }
    if (data.pid !== pid || !data.sessionId || !SESSION_ID.test(data.sessionId)) return null
    return { kind: 'claude', sessionId: data.sessionId, ...(data.name ? { name: data.name } : {}) }
  } catch {
    return null
  }
}

// O Codex mantém aberto ~/.codex/thread-writer-locks/<threadId>.lock enquanto escreve na conversa
// (criado na primeira mensagem, não ao abrir). Quem segura o arquivo diz qual processo é dono dela.
export function codexLocks(dir: string): CodexLock[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.lock') && SESSION_ID.test(f.slice(0, -5)))
      .map((f) => ({ threadId: f.slice(0, -5), file: join(dir, f), birthMs: statSync(join(dir, f)).birthtimeMs }))
  } catch {
    return []
  }
}

export class AgentDetector {
  constructor(private readonly sources: DetectorSources) {}

  private codexThreadsByPid(): Map<number, CodexLock> {
    const byPid = new Map<number, CodexLock>()
    for (const lock of codexLocks(this.sources.codexLocksDir)) {
      for (const pid of this.sources.lockHolders(lock.file)) {
        const current = byPid.get(pid)
        if (!current || lock.birthMs > current.birthMs) byPid.set(pid, lock)
      }
    }
    return byPid
  }

  detect(shellPids: Map<string, number>): Map<string, AgentSession> {
    const all = this.sources.listProcesses()
    const codex = this.codexThreadsByPid()
    const found = new Map<string, AgentSession>()

    for (const [tabId, shellPid] of shellPids) {
      let latest: { session: AgentSession; createdMs: number } | null = null
      for (const proc of descendants(shellPid, all)) {
        const lock = codex.get(proc.pid)
        const session: AgentSession | null = lock
          ? { kind: 'codex', sessionId: lock.threadId }
          : claudeSessionForPid(this.sources.claudeSessionsDir, proc.pid)
        if (!session) continue
        const createdMs = this.sources.creationTime(proc) ?? 0
        if (!latest || createdMs >= latest.createdMs) latest = { session, createdMs }
      }
      if (latest) found.set(tabId, latest.session)
    }
    return found
  }
}
