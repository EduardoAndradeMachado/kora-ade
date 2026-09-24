import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_ID, type AgentActivity, type AgentSession } from '../shared/agent'
import { claudeActivity, codexActivity, readTail } from './agent-activity'
import { descendants, type ProcInfo } from './processes'

export interface DetectorSources {
  claudeSessionsDir: string
  codexLocksDir: string
  listProcesses(): ProcInfo[]
  creationTime(p: ProcInfo): number | null
  lockHolders(file: string): number[]
  // Rollout (~/.codex/sessions/.../rollout-*-<threadId>.jsonl) da conversa, de onde sai o estado do Codex.
  codexRollout(threadId: string): string | null
}

export interface Detected {
  agent: AgentSession
  activity: AgentActivity | null
}

interface CodexLock {
  threadId: string
  file: string
  birthMs: number
}

// O Claude grava ~/.claude/sessions/<pid>.json enquanto o processo roda; o sessionId muda ali
// quando o usuário troca de conversa com /resume dentro dele, e o status acompanha a tela.
export function claudeStateForPid(dir: string, pid: number): Detected | null {
  try {
    const data = JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8')) as {
      pid?: number
      sessionId?: string
      name?: string
      status?: unknown
    }
    if (data.pid !== pid || !data.sessionId || !SESSION_ID.test(data.sessionId)) return null
    return {
      agent: { kind: 'claude', sessionId: data.sessionId, ...(data.name ? { name: data.name } : {}) },
      activity: claudeActivity(data.status)
    }
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

  detect(shellPids: Map<string, number>): Map<string, Detected> {
    const all = this.sources.listProcesses()
    const codex = this.codexThreadsByPid()
    const found = new Map<string, Detected>()

    for (const [tabId, shellPid] of shellPids) {
      let latest: { detected: Detected; createdMs: number } | null = null
      for (const proc of descendants(shellPid, all)) {
        const lock = codex.get(proc.pid)
        const detected: Detected | null = lock
          ? { agent: { kind: 'codex', sessionId: lock.threadId }, activity: this.codexActivityOf(lock.threadId) }
          : claudeStateForPid(this.sources.claudeSessionsDir, proc.pid)
        if (!detected) continue
        const createdMs = this.sources.creationTime(proc) ?? 0
        if (!latest || createdMs >= latest.createdMs) latest = { detected, createdMs }
      }
      if (latest) found.set(tabId, latest.detected)
    }
    return found
  }

  private codexActivityOf(threadId: string): AgentActivity | null {
    const file = this.sources.codexRollout(threadId)
    if (!file) return null
    try {
      return codexActivity(readTail(file))
    } catch {
      return null
    }
  }
}
