import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SESSION_ID, type AgentActivity, type AgentSession } from '../shared/agent'
import { claudeActivity, claudeTurnEnded, codexActivity, readTail } from './agent-activity'
import { descendants, type ProcInfo } from './processes'
import { claudeProjectDir } from './sessions'

// O agy segura presence/<conversa>.lock enquanto a conversa está carregada; os arquivos ficam depois que ele sai.
// Subagentes do agy não ganham lock: só a conversa principal.
export interface AntigravitySources {
  presenceLocks(): { id: string; file: string; birthMs: number }[]
  conversation(id: string): { subagent: boolean; activity: AgentActivity | null } | null
  // Quem segura qualquer um dos arquivos, numa consulta só.
  holders(files: string[]): number[]
}

export interface DetectorSources {
  claudeSessionsDir: string
  codexLocksDir: string
  listProcesses(): ProcInfo[]
  creationTime(p: ProcInfo): number | null
  lockHolders(file: string): number[]
  // Rollout (~/.codex/sessions/.../rollout-*-<threadId>.jsonl) da conversa, de onde sai o estado do Codex.
  codexRollout(threadId: string): string | null
  antigravity?: AntigravitySources
  now?(): number
}

export interface DerivedName {
  sessionId: string
  name: string
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

// O Claude dá à sessão um nome derivado da pasta (exemplo-75) e depois pode trocá-lo, pelo /rename ou sozinho
// pelo título da conversa. O arquivo do pid só guarda o nome atual; derivedNames lembra o primeiro enquanto o processo vive,
// preso à conversa em que foi visto: depois de um /resume para outra conversa, ele não é nome dela.
export function claudeStateForPid(
  dir: string,
  pid: number,
  derivedNames?: Map<number, DerivedName>
): Detected | typeof UNREADABLE | null {
  let text: string
  try {
    text = readFileSync(join(dir, `${pid}.json`), 'utf8')
  } catch {
    return null
  }
  let data: { pid?: number; sessionId?: string; name?: string; nameSource?: string; cwd?: string; status?: unknown }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    return UNREADABLE
  }
  if (data.pid !== pid || !data.sessionId || !SESSION_ID.test(data.sessionId)) return null
  if (derivedNames && data.name && data.nameSource === 'derived') derivedNames.set(pid, { sessionId: data.sessionId, name: data.name })
  const seen = derivedNames?.get(pid)
  const derivedName = seen?.sessionId === data.sessionId ? seen.name : undefined
  return {
    agent: {
      kind: 'claude',
      sessionId: data.sessionId,
      ...(data.name ? { name: data.name } : {}),
      ...(derivedName && derivedName !== data.name ? { derivedName } : {})
    },
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

// Busca completa pelos locks do agy custa ~30 ms: no máximo uma a cada este intervalo por processo sem conversa achada.
export const AGY_SCAN_GAP_MS = 3_000
// O lock de uma conversa nova nasce uns 2 s depois do processo; a folga cobre relógio e criação lenta.
const AGY_FRESH_SLACK_MS = 5_000

export class AgentDetector {
  constructor(private readonly sources: DetectorSources) {}

  private readonly subagentThreads = new Map<string, boolean>()
  private readonly derivedNames = new Map<number, DerivedName>()
  private readonly agyByPid = new Map<number, { id: string; file: string; createdMs: number | null }>()
  private readonly agyLastScan = new Map<number, number>()

  // O subagente do Codex roda dentro do processo que o criou, com conversa e lock próprios e mais novos que os da
  // conversa principal. A aba fica com a principal: é ela que o "Continuar" retoma e é nela que você responde.
  // Conversa cujo rollout ainda não deu para ler perde para a sabidamente principal: pode ser um subagente recém-criado.
  private codexThreadsByPid(): Map<number, CodexLock> {
    const byPid = new Map<number, { lock: CodexLock; known: boolean }>()
    for (const lock of codexLocks(this.sources.codexLocksDir)) {
      const subagent = this.isCodexSubagent(lock.threadId)
      if (subagent === true) continue
      const known = subagent === false
      for (const pid of this.sources.lockHolders(lock.file)) {
        const current = byPid.get(pid)
        const better =
          !current || (known && !current.known) || (known === current.known && lock.birthMs > current.lock.birthMs)
        if (better) byPid.set(pid, { lock, known })
      }
    }
    return new Map([...byPid].map(([pid, { lock }]) => [pid, lock]))
  }

  // UNREADABLE para a aba cujo agente não deu para ler nesta volta: quem chama mantém o que sabia dela.
  // A aba é do agente mais de fora: um Codex que o Claude roda como ferramenta (o code review dele, por exemplo) é filho
  // do Claude e não troca a aba, e vice-versa. OpenCode e agy contam como agentes de fora mesmo antes de ter conversa
  // achada (a aba do OpenCode já nasce vinculada; o agy cria o lock uns segundos depois de abrir): Claude ou Codex que
  // eles rodam como subagente não tomam a aba. Entre agentes lado a lado no terminal, vale o mais novo.
  detect(shellPids: Map<string, number>): Map<string, Detected | typeof UNREADABLE> {
    const all = this.sources.listProcesses()
    // O Windows reaproveita pid: o nome de um Claude que já saiu não pode ir parar no próximo processo com o mesmo número.
    // Lista vazia é a foto dos processos que falhou, não todos mortos; o nome derivado apagado não volta mais.
    if (all.length > 0) {
      const alive = new Set(all.map((p) => p.pid))
      for (const pid of this.derivedNames.keys()) if (!alive.has(pid)) this.derivedNames.delete(pid)
      for (const pid of this.agyByPid.keys()) if (!alive.has(pid)) this.agyByPid.delete(pid)
      for (const pid of this.agyLastScan.keys()) if (!alive.has(pid)) this.agyLastScan.delete(pid)
    }
    const parentOf = new Map(all.map((p) => [p.pid, p.ppid]))
    const codex = this.codexThreadsByPid()
    const found = new Map<string, Detected | typeof UNREADABLE>()

    let agyLocks: ReturnType<AntigravitySources['presenceLocks']> | null = null
    const locks = (): ReturnType<AntigravitySources['presenceLocks']> => (agyLocks ??= this.sources.antigravity?.presenceLocks() ?? [])

    for (const [tabId, shellPid] of shellPids) {
      const agents = new Map<number, { detected: Detected; proc: ProcInfo }>()
      // OpenCode e agy: agentes de fora mesmo sem conversa achada (o OpenCode não é detectado aqui; o agy, antes do lock).
      const outer = new Set<number>()
      const agyProcs: ProcInfo[] = []
      let unreadable = false
      for (const proc of descendants(shellPid, all)) {
        if (isOpencode(proc)) {
          outer.add(proc.pid)
          continue
        }
        if (isAgy(proc)) {
          outer.add(proc.pid)
          agyProcs.push(proc)
          continue
        }
        const lock = codex.get(proc.pid)
        const detected = lock
          ? { agent: { kind: 'codex' as const, sessionId: lock.threadId }, activity: this.codexActivityOf(lock.threadId) }
          : claudeStateForPid(this.sources.claudeSessionsDir, proc.pid, this.derivedNames)
        if (detected === UNREADABLE) unreadable = true
        if (!detected || detected === UNREADABLE) continue
        agents.set(proc.pid, { detected, proc })
      }
      const isAgent = (pid: number): boolean => agents.has(pid) || outer.has(pid)
      // Um agy rodado por outro agente (o Claude chamando agy -p, por exemplo) não é procurado: a busca custa e não toma a aba.
      for (const proc of agyProcs) {
        if (insideAnother(proc.pid, shellPid, parentOf, isAgent)) continue
        const id = this.agyConversationOf(proc, locks)
        if (!id) continue
        const state = this.sources.antigravity?.conversation(id)
        if (state?.subagent) continue
        agents.set(proc.pid, { detected: { agent: { kind: 'antigravity', sessionId: id }, activity: state?.activity ?? null }, proc })
      }
      let latest: { detected: Detected; createdMs: number } | null = null
      for (const { detected, proc } of agents.values()) {
        if (insideAnother(proc.pid, shellPid, parentOf, isAgent)) continue
        const createdMs = this.sources.creationTime(proc) ?? 0
        if (!latest || createdMs >= latest.createdMs) latest = { detected, createdMs }
      }
      if (latest) found.set(tabId, latest.detected)
      else if (unreadable) found.set(tabId, UNREADABLE)
    }
    return found
  }

  // Conversa cujo lock o processo segura. Do mais barato ao mais caro: a já conhecida (1 consulta), os locks nascidos
  // depois do processo (conversa nova), e por fim todos de uma vez com busca binária (~5 consultas em grupo).
  private agyConversationOf(proc: ProcInfo, locks: () => ReturnType<AntigravitySources['presenceLocks']>): string | null {
    const agy = this.sources.antigravity
    if (!agy) return null
    const createdMs = this.sources.creationTime(proc)
    const held = (files: string[]): boolean => agy.holders(files).includes(proc.pid)
    const remember = (lock: { id: string; file: string }): string => {
      this.agyByPid.set(proc.pid, { id: lock.id, file: lock.file, createdMs })
      this.agyLastScan.delete(proc.pid)
      return lock.id
    }
    const known = this.agyByPid.get(proc.pid)
    if (known && known.createdMs === createdMs && held([known.file])) return known.id
    this.agyByPid.delete(proc.pid)

    const all = locks()
    const fresh = createdMs === null ? [] : all.filter((l) => l.birthMs >= createdMs - AGY_FRESH_SLACK_MS).sort((a, b) => b.birthMs - a.birthMs)
    for (const lock of fresh) if (held([lock.file])) return remember(lock)

    const now = this.sources.now?.() ?? Date.now()
    if (now - (this.agyLastScan.get(proc.pid) ?? -Infinity) < AGY_SCAN_GAP_MS) return null
    this.agyLastScan.set(proc.pid, now)
    let group = all.filter((l) => !fresh.includes(l))
    if (!held(group.map((l) => l.file))) return null
    while (group.length > 1) {
      const half = group.slice(0, Math.ceil(group.length / 2))
      group = held(half.map((l) => l.file)) ? half : group.slice(half.length)
    }
    return group[0] && held([group[0].file]) ? remember(group[0]) : null
  }

  // null enquanto o rollout não existe ou a primeira linha ainda está sendo gravada.
  private isCodexSubagent(threadId: string): boolean | null {
    const known = this.subagentThreads.get(threadId)
    if (known !== undefined) return known
    const file = this.sources.codexRollout(threadId)
    if (!file) return null
    let subagent: boolean | null
    try {
      subagent = codexMetaIsSubagent(readHead(file, CODEX_META_BYTES))
    } catch {
      return null
    }
    if (subagent !== null) this.subagentThreads.set(threadId, subagent)
    return subagent
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

const isOpencode = (proc: ProcInfo): boolean => proc.name.toLowerCase() === 'opencode.exe'
const isAgy = (proc: ProcInfo): boolean => proc.name.toLowerCase() === 'agy.exe'

function insideAnother(pid: number, shellPid: number, parentOf: Map<number, number>, isAgent: (pid: number) => boolean): boolean {
  const seen = new Set<number>([pid])
  for (let parent = parentOf.get(pid); parent !== undefined && parent !== shellPid && !seen.has(parent); parent = parentOf.get(parent)) {
    if (isAgent(parent)) return true
    seen.add(parent)
  }
  return false
}

// A primeira linha do rollout (session_meta, ~22 KB com as instruções base) não muda depois de gravada.
const CODEX_META_BYTES = 64 * 1024

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, bytes, 0))
  } finally {
    closeSync(fd)
  }
}

export function codexMetaIsSubagent(head: string): boolean | null {
  const newline = head.indexOf('\n')
  if (newline < 0) return null
  try {
    const first = JSON.parse(head.slice(0, newline)) as { type?: unknown; payload?: { source?: unknown } }
    if (first.type !== 'session_meta') return null
    const source = first.payload?.source
    return typeof source === 'object' && source !== null && 'subagent' in source
  } catch {
    return null
  }
}
