import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentRef } from '../shared/agent'
import type { DayPoint, ResponseMetric, SessionMetrics } from '../shared/metrics'
import { ClaudeMetrics } from './metrics-claude'
import { CodexMetrics } from './metrics-codex'
import { opencodeDay, opencodeMetrics } from './metrics-opencode'
import { claudeProjectDir } from './sessions'

interface Accumulator {
  line(entry: Record<string, unknown>): void
}

interface Followed<A> {
  offset: number
  carry: string
  decoder: StringDecoder
  acc: A
}

const CHUNK_BYTES = 1 << 20

// Transcripts e rollouts só crescem no fim: guarda até onde leu e, na próxima vez, processa só o que entrou.
// Ler o arquivo inteiro a cada resposta travaria o main (e todos os terminais) em conversas de dezenas de MB.
export class JsonlFollower<A extends Accumulator> {
  private readonly files = new Map<string, Followed<A>>()
  private readonly busy = new Map<string, Promise<A | null>>()

  constructor(
    private readonly make: () => A,
    private readonly maxFiles = 64
  ) {}

  read(file: string): Promise<A | null> {
    // Duas leituras simultâneas do mesmo arquivo processariam o mesmo trecho duas vezes.
    const previous = this.busy.get(file) ?? Promise.resolve(null)
    const next = previous.then(() => this.catchUp(file))
    this.busy.set(file, next)
    void next.finally(() => this.busy.get(file) === next && this.busy.delete(file))
    return next
  }

  private async catchUp(file: string): Promise<A | null> {
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      this.files.delete(file)
      return null
    }
    let f = this.files.get(file)
    // Arquivo menor que o já lido foi reescrito: recomeça do zero.
    if (!f || size < f.offset) f = { offset: 0, carry: '', decoder: new StringDecoder('utf8'), acc: this.make() }
    this.files.delete(file)
    this.files.set(file, f)
    if (this.files.size > this.maxFiles) this.files.delete(this.files.keys().next().value!)
    if (size === f.offset) return f.acc

    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - f.offset))
      while (f.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - f.offset), f.offset)
        if (bytesRead === 0) break
        f.offset += bytesRead
        const lines = (f.carry + f.decoder.write(buffer.subarray(0, bytesRead))).split('\n')
        // A última linha pode estar sendo escrita agora; fica para a próxima leitura.
        f.carry = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            f.acc.line(JSON.parse(line) as Record<string, unknown>)
          } catch {
            // linha corrompida não derruba o resto da conversa
          }
        }
      }
    } finally {
      await handle.close()
    }
    return f.acc
  }
}

export interface MetricsSources {
  claudeRoot: string
  codexSessions: string
  codexRollout(threadId: string): string | null
  opencodeDb: string
}

const claude = new JsonlFollower(() => new ClaudeMetrics())
const claudeSubagent = new JsonlFollower(() => new ClaudeMetrics(true), 256)
const codex = new JsonlFollower(() => new CodexMetrics(), 256)

async function claudeTranscript(claudeRoot: string, projectPath: string, sessionId: string): Promise<string | null> {
  const expected = join(claudeProjectDir(claudeRoot, projectPath), `${sessionId}.jsonl`)
  if (existsSync(expected)) return expected
  // Conversa retomada a partir de outra pasta fica gravada na pasta de origem.
  const projects = join(claudeRoot, 'projects')
  try {
    for (const dir of await readdir(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Claude nunca usado nesta máquina.
  }
  return null
}

// <pasta>/<sessão>.jsonl → <pasta>/<sessão>/subagents/agent-*.jsonl (inclui os subagentes lançados por subagentes).
export async function claudeSubagentFiles(transcript: string): Promise<string[]> {
  const dir = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
  try {
    return (await readdir(dir)).filter((name) => /^agent-.*\.jsonl$/.test(name)).map((name) => join(dir, name))
  } catch {
    return []
  }
}

async function listCodexRollouts(sessionsDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionsDir, { recursive: true, encoding: 'utf8' }))
      .filter((rel) => /rollout-.*\.jsonl$/.test(rel))
      .map((rel) => join(sessionsDir, rel))
  } catch {
    // Codex nunca usado nesta máquina.
    return []
  }
}

const CODEX_THREAD = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const HEAD_CHUNK = 64 * 1024
const HEAD_MAX = 1024 * 1024
// A primeira linha do rollout (session_meta) não muda depois de gravada: lida uma vez por arquivo.
const codexParents = new Map<string, string | null>()

async function codexParentOf(file: string): Promise<string | null> {
  if (codexParents.has(file)) return codexParents.get(file)!
  let head = ''
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_CHUNK)
      const decoder = new StringDecoder('utf8')
      for (let offset = 0; offset < HEAD_MAX && !head.includes('\n'); offset += HEAD_CHUNK) {
        const { bytesRead } = await handle.read(buffer, 0, HEAD_CHUNK, offset)
        if (bytesRead === 0) break
        head += decoder.write(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  const newline = head.indexOf('\n')
  // Primeira linha ainda sendo gravada: tenta de novo na próxima leitura.
  if (newline < 0) return null
  let parent: string | null = null
  try {
    const meta = JSON.parse(head.slice(0, newline)) as {
      payload?: { source?: { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } } }
    }
    const id = meta.payload?.source?.subagent?.thread_spawn?.parent_thread_id
    if (typeof id === 'string') parent = id
  } catch {
    // cabeçalho ilegível: trata como conversa principal
  }
  codexParents.set(file, parent)
  return parent
}

// Subagentes do Codex são conversas próprias que apontam para a conversa que as lançou (parent_thread_id).
export async function codexSubagentFiles(sessionsDir: string, threadId: string, rootFile: string): Promise<string[]> {
  let bornAt: number
  try {
    bornAt = (await stat(rootFile)).birthtimeMs
  } catch {
    return []
  }
  const byParent = new Map<string, string[]>()
  for (const file of await listCodexRollouts(sessionsDir)) {
    if (file === rootFile) continue
    try {
      // Subagente nasce depois da conversa que o lança; isso evita abrir o cabeçalho de todo o histórico.
      if ((await stat(file)).birthtimeMs < bornAt) continue
    } catch {
      continue
    }
    const parent = await codexParentOf(file)
    if (parent) byParent.set(parent, [...(byParent.get(parent) ?? []), file])
  }
  const found: string[] = []
  const queue = [threadId]
  while (queue.length > 0) {
    for (const file of byParent.get(queue.shift()!) ?? []) {
      if (found.includes(file)) continue
      found.push(file)
      const child = CODEX_THREAD.exec(file)?.[1]
      if (child) queue.push(child)
    }
  }
  return found
}

async function responsesOf<A extends Accumulator & { snapshot(id: string): SessionMetrics }>(
  follower: JsonlFollower<A>,
  files: string[]
): Promise<ResponseMetric[]> {
  const out: ResponseMetric[] = []
  for (const file of files) {
    const acc = await follower.read(file)
    if (acc) out.push(...acc.snapshot('').responses)
  }
  return out.sort((a, b) => a.at - b.at)
}

export async function sessionMetrics(sources: MetricsSources, agent: AgentRef, projectPath: string): Promise<SessionMetrics> {
  if (agent.kind === 'opencode') return opencodeMetrics(sources.opencodeDb, agent.sessionId)
  if (agent.kind === 'claude') {
    const file = await claudeTranscript(sources.claudeRoot, projectPath, agent.sessionId)
    const acc = file ? await claude.read(file) : null
    const metrics = (acc ?? new ClaudeMetrics()).snapshot(agent.sessionId)
    if (!file) return metrics
    return { ...metrics, subagentResponses: await responsesOf(claudeSubagent, await claudeSubagentFiles(file)) }
  }
  const file = sources.codexRollout(agent.sessionId)
  const acc = file ? await codex.read(file) : null
  const metrics = (acc ?? new CodexMetrics()).snapshot(agent.sessionId)
  if (!file) return metrics
  return {
    ...metrics,
    subagentResponses: await responsesOf(codex, await codexSubagentFiles(sources.codexSessions, agent.sessionId, file))
  }
}

async function touchedSince(files: string[], since: number): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    try {
      if ((await stat(file)).mtimeMs >= since) out.push(file)
    } catch {
      // apagado entre a listagem e o stat
    }
  }
  return out
}

function points(agent: SessionMetrics['agent'], responses: ResponseMetric[], since: number): DayPoint[] {
  return responses.flatMap((r) =>
    r.at >= since && r.tps !== null ? [{ at: r.at, agent, model: r.model, tps: r.tps, outputTokens: r.outputTokens }] : []
  )
}

// TPS de todas as respostas desde `since`, dos três agentes e dos subagentes deles, em qualquer pasta.
export async function dayMetrics(sources: MetricsSources, since: number): Promise<DayPoint[]> {
  const claudeFiles: string[] = []
  const projects = join(sources.claudeRoot, 'projects')
  try {
    for (const dir of await readdir(projects)) {
      try {
        for (const name of await readdir(join(projects, dir))) if (name.endsWith('.jsonl')) claudeFiles.push(join(projects, dir, name))
      } catch {
        // entrada que não é pasta
      }
    }
  } catch {
    // Claude nunca usado nesta máquina.
  }

  const out: DayPoint[] = []
  for (const file of await touchedSince(claudeFiles, since)) {
    const acc = await claude.read(file)
    if (acc) out.push(...points('claude', acc.snapshot('').responses, since))
    const subagents = await touchedSince(await claudeSubagentFiles(file), since)
    out.push(...points('claude', await responsesOf(claudeSubagent, subagents), since))
  }
  // Os subagentes do Codex são rollouts próprios e já entram nesta lista.
  for (const file of await touchedSince(await listCodexRollouts(sources.codexSessions), since)) {
    const acc = await codex.read(file)
    if (acc) out.push(...points('codex', acc.snapshot('').responses, since))
  }
  out.push(...opencodeDay(sources.opencodeDb, since))
  return out.sort((a, b) => a.at - b.at)
}
