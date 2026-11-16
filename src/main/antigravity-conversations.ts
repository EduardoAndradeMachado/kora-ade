import { existsSync, readdirSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { SESSION_ID, type AgentActivity } from '../shared/agent'
import type { SessionSummary } from '../shared/ipc'

// Pasta de dados do agy (Antigravity CLI): conversations/<id>.db, presence/<id>.lock, cache/ e history.jsonl.
export const agyRoot = (): string => join(homedir(), '.gemini', 'antigravity-cli')

const TITLE_MAX = 90
// Só os passos do fim interessam para saber se o turno acabou; conversas longas passam de mil passos.
const RECENT_STEPS = 40

// ───────────── protobuf mínimo (formato de fio), só o necessário para ler os campos abaixo ─────────────

type Fields = Map<number, (bigint | Uint8Array)[]>

function readVarint(buf: Uint8Array, at: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  for (let i = at; i < buf.length && shift < 70n; i++) {
    const byte = buf[i]!
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result, i + 1]
    shift += 7n
  }
  throw new Error('varint truncado')
}

/** Campos do nível de cima de uma mensagem protobuf; lança se os bytes não formam uma mensagem válida. */
export function protoFields(buf: Uint8Array): Fields {
  const fields: Fields = new Map()
  let at = 0
  while (at < buf.length) {
    const [key, next] = readVarint(buf, at)
    at = next
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (field === 0) throw new Error('campo 0')
    let value: bigint | Uint8Array
    if (wire === 0) [value, at] = readVarint(buf, at)
    else if (wire === 2) {
      const [length, start] = readVarint(buf, at)
      const end = start + Number(length)
      if (end > buf.length) throw new Error('campo truncado')
      value = buf.subarray(start, end)
      at = end
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4
      if (at + size > buf.length) throw new Error('campo truncado')
      value = buf.subarray(at, at + size)
      at += size
    } else throw new Error(`tipo de fio ${wire}`)
    const list = fields.get(field) ?? []
    list.push(value)
    fields.set(field, list)
  }
  return fields
}

const text = (value: bigint | Uint8Array | undefined): string | null =>
  value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null

// ───────────── metadados da conversa (trajectory_metadata_blob), conferidos no agy 1.5.9 ─────────────

export interface AgyConversationMeta {
  workspace: string | null
  // Conversa que lançou esta por invoke_subagent; só as de subagente têm.
  parentId: string | null
}

// Campo 7 é a pasta da conversa (file:///...); o 1.1 repete a mesma pasta. O campo 5 é a conversa-mãe, presente
// só nas conversas que o agy cria para subagentes (DeepCoder, DeepInvestigator e os definidos pelo usuário).
export function parseAgyConversationMeta(blob: Uint8Array): AgyConversationMeta {
  const fields = protoFields(blob)
  let workspace = text(fields.get(7)?.[0])
  if (!workspace) {
    const first = fields.get(1)?.[0]
    if (first instanceof Uint8Array) workspace = text(protoFields(first).get(1)?.[0])
  }
  const parent = text(fields.get(5)?.[0])
  return { workspace: workspace || null, parentId: parent && SESSION_ID.test(parent) ? parent : null }
}

export interface AgyStep {
  type: number
  status: number
  payload: Uint8Array | null
}

// CortexStepStatus do agy: valores do enum embutido no binário.
const STEP_PENDING = 1
const STEP_RUNNING = 2
const STEP_DONE = 3
const STEP_CANCELED = 6
const STEP_ERROR = 7
const STEP_GENERATING = 8
const STEP_WAITING = 9
const STEP_QUEUED = 11
const STEP_INTERRUPTED = 12
const IN_PROGRESS = new Set([STEP_PENDING, STEP_RUNNING, STEP_GENERATING, STEP_QUEUED])
const TURN_STOPPED = new Set([STEP_CANCELED, STEP_ERROR, STEP_INTERRUPTED])
// Resposta do modelo (planner response): o campo 20 traz o texto e, no 20.7, as ferramentas que ele pediu.
const PLANNER_RESPONSE = 15

function plannerCallsTools(payload: Uint8Array | null): boolean | null {
  if (!payload) return null
  try {
    const response = protoFields(payload).get(20)?.[0]
    if (!(response instanceof Uint8Array)) return null
    return protoFields(response).has(7)
  } catch {
    return null
  }
}

/**
 * Estado do turno pelos passos mais recentes, do mais antigo para o mais novo. O agy só grava a resposta do modelo
 * quando ela termina; enquanto ele pensa, o último passo é o pedido ou o resultado de uma ferramenta.
 */
export function agyActivity(steps: AgyStep[]): AgentActivity {
  if (steps.some((s) => s.status === STEP_WAITING)) return 'waiting'
  if (steps.some((s) => IN_PROGRESS.has(s.status))) return 'working'
  const last = steps.at(-1)
  if (!last) return 'waiting'
  if (TURN_STOPPED.has(last.status)) return 'waiting'
  if (last.type === PLANNER_RESPONSE && last.status === STEP_DONE) return plannerCallsTools(last.payload) === false ? 'waiting' : 'working'
  return 'working'
}

export interface AgyConversationState {
  subagent: boolean
  activity: AgentActivity | null
}

// Banco aberto e fechado a cada leitura: o agy segue gravando nele (WAL) e uma conexão parada veria o arquivo antigo.
// Sem -wal (conversa fechada), abre como imutável: a abertura comum, mesmo só-leitura, cria -wal e -shm na pasta do agy.
function withDb<T>(file: string, read: (db: DatabaseSync) => T): T | null {
  if (!existsSync(file)) return null
  let db: DatabaseSync | null = null
  try {
    let target: string | URL = file
    if (!existsSync(`${file}-wal`)) {
      target = pathToFileURL(file)
      target.searchParams.set('immutable', '1')
    }
    db = new DatabaseSync(target, { readOnly: true })
    return read(db)
  } catch {
    return null
  } finally {
    db?.close()
  }
}

const bytes = (value: unknown): Uint8Array | null => (value instanceof Uint8Array ? value : null)

const metaCache = new Map<string, AgyConversationMeta>()

// Os metadados não mudam depois de gravados: lidos uma vez por arquivo.
export function agyConversationMeta(dbFile: string): AgyConversationMeta | null {
  const cached = metaCache.get(dbFile)
  if (cached) return cached
  const meta = withDb(dbFile, (db) => {
    const row = db.prepare('select data from trajectory_metadata_blob limit 1').get() as { data?: unknown } | undefined
    const blob = bytes(row?.data)
    return blob ? parseAgyConversationMeta(blob) : null
  })
  if (meta) metaCache.set(dbFile, meta)
  return meta
}

export const agyConversationFile = (root: string, id: string): string => join(root, 'conversations', `${id}.db`)

/** null quando a conversa não deu para ler agora (banco ausente, travado ou em formato desconhecido). */
export function readAgyConversation(root: string, id: string): AgyConversationState | null {
  const file = agyConversationFile(root, id)
  const meta = agyConversationMeta(file)
  if (!meta) return null
  const steps = withDb(file, (db) =>
    (db.prepare(`select step_type, status, step_payload from steps order by idx desc limit ${RECENT_STEPS}`).all() as {
      step_type: number
      status: number
      step_payload: unknown
    }[])
      .reverse()
      .map((r) => ({ type: Number(r.step_type), status: Number(r.status), payload: bytes(r.step_payload) }))
  )
  return { subagent: meta.parentId !== null, activity: steps ? agyActivity(steps) : null }
}

// ───────────── listagem por projeto ─────────────

interface AgySummary {
  title: string
  preview: string
  updatedAt: number
  internal: boolean
}

function workspacePath(uri: string): string | null {
  try {
    return resolve(fileURLToPath(uri))
  } catch {
    return null
  }
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

const clip = (value: string): string => {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine
}

// Índice que o agy mantém com título e prévia; não traz a conversa aberta agora, por isso o history.jsonl de reserva.
async function summaries(root: string): Promise<Map<string, AgySummary>> {
  const found = new Map<string, AgySummary>()
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(root, 'cache', 'conversation_metadata.json'), 'utf8'))
  } catch {
    return found
  }
  const conversations = (raw as { conversations?: unknown } | null)?.conversations
  if (typeof conversations !== 'object' || conversations === null) return found
  for (const [id, entry] of Object.entries(conversations as Record<string, unknown>)) {
    const e = entry as { is_internal?: unknown; summary?: Record<string, unknown> }
    const s = e.summary ?? {}
    const updated = Date.parse(String(s['UpdatedAt'] ?? ''))
    found.set(id, {
      title: typeof s['Title'] === 'string' ? s['Title'] : '',
      preview: typeof s['Preview'] === 'string' ? s['Preview'] : '',
      // Data zero do Go (ano 1) é "nunca atualizada".
      updatedAt: Number.isFinite(updated) && updated > 0 ? updated : 0,
      internal: e.is_internal === true || s['Internal'] === true
    })
  }
  return found
}

// Primeiro prompt de cada conversa, para título de quem ainda não está no índice.
async function firstPrompts(root: string): Promise<Map<string, { text: string; at: number }>> {
  const found = new Map<string, { text: string; at: number }>()
  let raw: string
  try {
    raw = await readFile(join(root, 'history.jsonl'), 'utf8')
  } catch {
    return found
  }
  for (const line of raw.split('\n')) {
    let entry: { display?: unknown; conversationId?: unknown; timestamp?: unknown; type?: unknown }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    if (typeof entry.conversationId !== 'string' || typeof entry.display !== 'string' || entry.type === 'slash_command') continue
    const at = typeof entry.timestamp === 'number' ? entry.timestamp : 0
    const current = found.get(entry.conversationId)
    if (!current) found.set(entry.conversationId, { text: entry.display, at })
    else current.at = Math.max(current.at, at)
  }
  return found
}

// -wal vazio não é escrita nova: o SQLite o deixa assim depois do checkpoint.
function mtime(file: string): number {
  try {
    const info = statSync(file)
    return info.size > 0 ? info.mtimeMs : 0
  } catch {
    return 0
  }
}

/** Conversas do agy cuja pasta é o projeto, sem as de subagente e sem as vazias (abertas e fechadas sem pedido). */
export async function listAntigravitySessions(root: string, projectPath: string): Promise<SessionSummary[]> {
  const dir = join(root, 'conversations')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const [index, prompts] = await Promise.all([summaries(root), firstPrompts(root)])
  const sessions: SessionSummary[] = []
  for (const name of names) {
    const sessionId = name.endsWith('.db') ? name.slice(0, -3) : ''
    if (!SESSION_ID.test(sessionId)) continue
    const file = join(dir, name)
    const meta = agyConversationMeta(file)
    if (!meta || meta.parentId || !meta.workspace) continue
    const path = workspacePath(meta.workspace)
    if (!path || !samePath(path, projectPath)) continue
    const summary = index.get(sessionId)
    if (summary?.internal) continue
    const prompt = prompts.get(sessionId)
    const title = summary?.title || summary?.preview || prompt?.text
    if (!title) continue
    const updatedAt = Math.max(mtime(file), mtime(`${file}-wal`), summary?.updatedAt ?? 0, prompt?.at ?? 0)
    sessions.push({ kind: 'antigravity', sessionId, title: clip(title), updatedAt })
  }
  return sessions
}

/** Conversa cujo arquivo de presença o agy cria ao abrir e segura aberto enquanto ela está carregada. */
export const agyPresenceDir = (root: string): string => join(root, 'presence')

export function agyPresenceLocks(root: string): { id: string; file: string; birthMs: number }[] {
  const dir = agyPresenceDir(root)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const locks: { id: string; file: string; birthMs: number }[] = []
  for (const name of names) {
    const id = name.endsWith('.lock') ? name.slice(0, -5) : ''
    if (!SESSION_ID.test(id)) continue
    const file = join(dir, name)
    try {
      locks.push({ id, file, birthMs: statSync(file).birthtimeMs })
    } catch {
      // removido entre o readdir e o stat
    }
  }
  return locks
}
