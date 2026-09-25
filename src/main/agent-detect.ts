import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SESSION_ID, type AgentActivity, type AgentSession } from '../shared/agent'
import { claudeActivity, claudeTurnEnded, codexActivity, readTail } from './agent-activity'
import { descendants, type ProcInfo } from './processes'
import { claudeProjectDir } from './sessions'

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
// O Claude reescreve esse arquivo a cada mudança de status, e o watch dispara a detecção justamente nessa hora:
// arquivo que existe mas vem pela metade é "sem leitura agora", não "sem Claude". Tratar como ausência fazia a
// aba passar por "sem estado" entre trabalhando e esperando, e o aviso de sessão parada se perdia.
export const UNREADABLE = 'sem-leitura'

export function claudeStateForPid(dir: string, pid: number): Detected | typeof UNREADABLE | null {
  let text: string
  try {
    text = readFileSync(join(dir, `${pid}.json`), 'utf8')
  } catch {
    return null
  }
  let data: { pid?: number; sessionId?: string; name?: string; cwd?: string; status?: unknown }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    return UNREADABLE
  }
  if (data.pid !== pid || !data.sessionId || !SESSION_ID.test(data.sessionId)) return null
  return {
    agent: { kind: 'claude', sessionId: data.sessionId, ...(data.name ? { name: data.name } : {}) },
    activity: data.status === 'busy' && claudeTurnEndedFor(dir, data.cwd, data.sessionId) ? 'waiting' : claudeActivity(data.status)
  }
}

const CLAUDE_TAIL_BYTES = 64 * 1024

// Transcript ausente ou fim de turno fora do trecho lido: vale o status do arquivo do pid.
function claudeTurnEndedFor(sessionsDir: string, cwd: string | undefined, sessionId: string): boolean {
  if (!cwd) return false
  const transcript = join(claudeProjectDir(dirname(sessionsDir), cwd), `${sessionId}.jsonl`)
  try {
    return claudeTurnEnded(readTail(transcript, CLAUDE_TAIL_BYTES))
  } catch {
    return false
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

  // UNREADABLE para a aba cujo agente não deu para ler nesta volta: quem chama mantém o que sabia dela.
  detect(shellPids: Map<string, number>): Map<string, Detected | typeof UNREADABLE> {
    const all = this.sources.listProcesses()
    const codex = this.codexThreadsByPid()
    const found = new Map<string, Detected | typeof UNREADABLE>()

    for (const [tabId, shellPid] of shellPids) {
      let latest: { detected: Detected; createdMs: number } | null = null
      let unreadable = false
      for (const proc of descendants(shellPid, all)) {
        const lock = codex.get(proc.pid)
        const detected = lock
          ? { agent: { kind: 'codex' as const, sessionId: lock.threadId }, activity: this.codexActivityOf(lock.threadId) }
          : claudeStateForPid(this.sources.claudeSessionsDir, proc.pid)
        if (detected === UNREADABLE) unreadable = true
        if (!detected || detected === UNREADABLE) continue
        const createdMs = this.sources.creationTime(proc) ?? 0
        if (!latest || createdMs >= latest.createdMs) latest = { detected, createdMs }
      }
      if (latest) found.set(tabId, latest.detected)
      else if (unreadable) found.set(tabId, UNREADABLE)
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
