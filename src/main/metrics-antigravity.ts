import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { off, type DayPoint, type ResponseMetric, type SessionMetrics } from '../shared/metrics'
import { agyConversationFile, agyConversationMeta, protoFields, withDb } from './antigravity-conversations'
import { agyCost } from './pricing'

// Passos do agy 1.5.10 (conferidos em 80 conversas): 14 pedido do usuário, 15 resposta do modelo, 23 compactação.
// A resposta e a compactação trazem no metadata os horários, o uso de tokens e o código do modelo.
const USER_INPUT = 14
const PLANNER_RESPONSE = 15
const COMPACTION = 23
const STEP_DONE = 3
const STEP_CANCELED = 6
const STEP_ERROR = 7
const STEP_INTERRUPTED = 12
// Passo nesses status não muda mais; os outros (rodando, gerando, esperando) ainda podem mudar.
const FINAL = new Set([STEP_DONE, STEP_CANCELED, STEP_ERROR, STEP_INTERRUPTED])
const MIN_TPS_MS = 250

export interface AgyStepRow {
  type: number
  status: number
  metadata: Uint8Array | null
}

type Fields = ReturnType<typeof protoFields>

const first = (fields: Fields, field: number): bigint | Uint8Array | undefined => fields.get(field)?.[0]
const int = (value: bigint | Uint8Array | undefined): number => (typeof value === 'bigint' ? Number(value) : 0)
const sub = (value: bigint | Uint8Array | undefined): Fields | null => (value instanceof Uint8Array ? protoFields(value) : null)

// google.protobuf.Timestamp: segundos no campo 1, nanossegundos no 2.
function timestamp(value: bigint | Uint8Array | undefined): number | null {
  const t = sub(value)
  if (!t) return null
  const seconds = int(first(t, 1))
  return seconds > 0 ? seconds * 1000 + Math.floor(int(first(t, 2)) / 1e6) : null
}

/**
 * Nome do modelo pelo código gravado no passo e pela linha de gen_metadata que gerou a resposta. A primeira
 * resposta da conversa não grava a linha (campo 20.3); ela é sempre a linha 0.
 */
export type AgyModelOf = (modelCode: number | null, generation: number) => string

// Uso: 1 código do modelo, 2 entrada sem cache, 5 cache lido, 3 saída (raciocínio + resposta). Fica no campo 9;
// em parte das compactações o 9 vem só com ids e as contagens estão no 28.2. Contagem zero não é gravada.
const hasCounts = (usage: Fields | null): usage is Fields => !!usage && (usage.has(2) || usage.has(3) || usage.has(5))

function usageOf(meta: Fields): Fields | null {
  const main = sub(first(meta, 9))
  if (hasCounts(main)) return main
  const compaction = sub(first(meta, 28))
  const fallback = compaction ? sub(first(compaction, 2)) : null
  return hasCounts(fallback) ? fallback : null
}

function response(meta: Fields, modelOf: AgyModelOf): ResponseMetric | null {
  const usage = usageOf(meta)
  // A compactação não grava o campo 7 (fim); o 8 marca a mesma hora nas respostas.
  const at = timestamp(first(meta, 7)) ?? timestamp(first(meta, 8))
  if (!usage || at === null) return null
  const start = timestamp(first(meta, 1))
  const input = int(first(usage, 2))
  const cached = int(first(usage, 5))
  const output = int(first(usage, 3))
  const code = first(meta, 11) ?? first(usage, 1) ?? first(sub(first(meta, 9)) ?? new Map(), 1)
  const generation = sub(first(meta, 20))
  const model = modelOf(typeof code === 'bigint' ? Number(code) : null, generation?.has(3) ? int(first(generation, 3)) : 0)
  const durationMs = start !== null && at > start ? at - start : null
  return {
    at,
    model,
    inputTokens: input,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: output,
    contextTokens: input + cached,
    durationMs,
    tps: durationMs !== null && durationMs >= MIN_TPS_MS && output > 0 ? output / (durationMs / 1000) : null,
    costUsd: agyCost(model, at, { input, cached, output }) ?? off(`Sem preço de API para ${model} na tabela do Kora.`)
  }
}

export interface AgyTally {
  responses: ResponseMetric[]
  turns: number
  interruptions: number
  compactions: number
  // O turno atual já teve passo cancelado ou interrompido: conta uma interrupção por turno.
  stoppedThisTurn: boolean
}

export const emptyTally = (): AgyTally => ({ responses: [], turns: 0, interruptions: 0, compactions: 0, stoppedThisTurn: false })

/** Soma um passo ao tally (que é alterado). Metadado ilegível tira só aquele passo da conta. */
export function addAgyStep(tally: AgyTally, step: AgyStepRow, modelOf: AgyModelOf): void {
  if (step.type === USER_INPUT) {
    tally.turns++
    tally.stoppedThisTurn = false
  }
  if ((step.status === STEP_CANCELED || step.status === STEP_INTERRUPTED) && !tally.stoppedThisTurn) {
    tally.interruptions++
    tally.stoppedThisTurn = true
  }
  if (step.type === COMPACTION && step.status === STEP_DONE) tally.compactions++
  if ((step.type !== PLANNER_RESPONSE && step.type !== COMPACTION) || step.status !== STEP_DONE || !step.metadata) return
  try {
    const r = response(protoFields(step.metadata), modelOf)
    if (r) tally.responses.push(r)
  } catch {
    // metadado em formato desconhecido
  }
}

/** Passos em ordem de idx. */
export function tallyAgySteps(steps: AgyStepRow[], modelOf: AgyModelOf): AgyTally {
  const tally = emptyTally()
  for (const step of steps) addAgyStep(tally, step, modelOf)
  return tally
}

const copyTally = (t: AgyTally): AgyTally => ({ ...t, responses: [...t.responses] })

interface Followed {
  // Tamanho e horário do .db e do -wal na última leitura.
  version: string | null
  // Tudo até stableIdx já está em status final e somado em stable; daí em diante é relido a cada vez.
  stableIdx: number
  stableMeta: Uint8Array | null
  stable: AgyTally
  last: AgyTally
  // O mesmo código vale nomes diferentes em conversas diferentes (1298 é gemini-flash-safety-le2 numa e
  // gemini-3.7-flash noutra), então o nome é guardado por conversa.
  names: Map<number, string>
}

const followed = new Map<string, Followed>()
const MAX_FOLLOWED = 128

function modelReader(db: DatabaseSync, names: Map<number, string>): AgyModelOf {
  let statement: StatementSync | null = null
  return (code, generation) => {
    const known = code !== null ? names.get(code) : undefined
    if (known) return known
    let name: string | null = null
    try {
      // A linha de gen_metadata carrega o prompt inteiro (MBs): só é lida para código ainda sem nome.
      statement ??= db.prepare('select data from gen_metadata where idx = ?')
      const row = statement.get(generation) as { data?: unknown } | undefined
      const request = row?.data instanceof Uint8Array ? sub(first(protoFields(row.data), 1)) : null
      const value = request ? first(request, 19) : undefined
      name = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null
    } catch {
      // tabela, linha ou formato ausente: fica sem nome e sem preço, sem derrubar o resto da conversa
    }
    if (!name) return 'desconhecido'
    if (code !== null) names.set(code, name)
    return name
  }
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
  a === b || (!!a && !!b && a.length === b.length && Buffer.from(a).equals(Buffer.from(b)))

function catchUp(db: DatabaseSync, f: Followed): AgyTally {
  // Conversa reescrita (passo final mudou ou sumiu): recomeça do zero.
  if (f.stableIdx >= 0) {
    const row = db.prepare('select metadata from steps where idx = ?').get(f.stableIdx) as { metadata?: unknown } | undefined
    const meta = row?.metadata instanceof Uint8Array ? row.metadata : null
    if (!row || !sameBytes(meta, f.stableMeta)) {
      f.stableIdx = -1
      f.stableMeta = null
      f.stable = emptyTally()
      f.names.clear()
    }
  }
  const rows = db.prepare('select idx, step_type, status, metadata from steps where idx > ? order by idx').all(f.stableIdx) as {
    idx: number
    step_type: number
    status: number
    metadata: unknown
  }[]
  const modelOf = modelReader(db, f.names)
  const current = copyTally(f.stable)
  let settled = true
  for (const r of rows) {
    const step = { type: Number(r.step_type), status: Number(r.status), metadata: r.metadata instanceof Uint8Array ? r.metadata : null }
    addAgyStep(current, step, modelOf)
    settled &&= FINAL.has(step.status)
    if (settled) {
      f.stableIdx = Number(r.idx)
      f.stableMeta = step.metadata
      f.stable = copyTally(current)
    }
  }
  f.last = current
  return current
}

/**
 * Lê só os passos novos desde a última leitura. Banco ilegível agora (travado, no meio de um checkpoint) devolve
 * o último resultado; null só quando a conversa nunca foi lida.
 */
function readTally(file: string): AgyTally | null {
  let f = followed.get(file)
  // Abrir o SQLite custa ~1 ms por conversa e o painel de hoje passa por dezenas delas a cada 30 s: arquivo
  // igual à última leitura não é reaberto.
  const version = fileVersion(file)
  if (f && version !== null && f.version === version) return f.last
  const fresh: Followed = f ?? { version: null, stableIdx: -1, stableMeta: null, stable: emptyTally(), last: emptyTally(), names: new Map() }
  const result = withDb(file, (db) => catchUp(db, fresh))
  if (result === null) return f ? f.last : null
  fresh.version = version
  if (!f) {
    f = fresh
    followed.set(file, f)
    if (followed.size > MAX_FOLLOWED) followed.delete(followed.keys().next().value!)
  }
  return result
}

// Com a conversa aberta o agy grava no -wal e o .db só muda no checkpoint: os dois entram na versão.
function fileVersion(file: string): string | null {
  try {
    const db = statSync(file)
    const wal = existsSync(`${file}-wal`) ? statSync(`${file}-wal`) : null
    return `${db.mtimeMs}:${db.size}:${wal ? `${wal.mtimeMs}:${wal.size}` : '-'}`
  } catch {
    return null
  }
}

function conversationFiles(root: string): string[] {
  const dir = join(root, 'conversations')
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

// Subagentes do agy são conversas próprias que apontam para a que as lançou; um subagente pode lançar outro.
function subagentFiles(root: string, sessionId: string): string[] {
  const byParent = new Map<string, string[]>()
  for (const file of conversationFiles(root)) {
    if (basename(file, '.db') === sessionId) continue
    const parent = agyConversationMeta(file)?.parentId
    if (parent) byParent.set(parent, [...(byParent.get(parent) ?? []), file])
  }
  const found: string[] = []
  const queue = [sessionId]
  while (queue.length > 0) {
    for (const file of byParent.get(queue.shift()!) ?? []) {
      if (found.includes(file)) continue
      found.push(file)
      queue.push(basename(file, '.db'))
    }
  }
  return found
}

export function agyMetrics(root: string, sessionId: string): SessionMetrics {
  const file = agyConversationFile(root, sessionId)
  const tally = readTally(file)
  if (!tally && existsSync(file)) throw new Error('Não deu para ler a conversa do Antigravity agora; tento de novo na próxima atualização.')
  const own = tally ?? emptyTally()
  const children = subagentFiles(root, sessionId)
  const subagentResponses = children.flatMap((child) => readTally(child)?.responses ?? []).sort((a, b) => a.at - b.at)
  return {
    agent: 'antigravity',
    sessionId,
    responses: own.responses,
    subagentResponses,
    turns: own.turns,
    costKind: 'estimado',
    contextWindow: off('O Antigravity não grava o tamanho da janela de contexto na conversa.'),
    interruptions: own.interruptions,
    subagents: children.length,
    compactions: own.compactions
  }
}

// Com a conversa aberta o agy grava no -wal e o .db só muda no checkpoint.
function touchedSince(file: string, since: number): boolean {
  for (const f of [file, `${file}-wal`]) {
    try {
      if (existsSync(f) && statSync(f).mtimeMs >= since) return true
    } catch {
      // apagado entre a listagem e o stat
    }
  }
  return false
}

export function agyDay(root: string, since: number): DayPoint[] {
  const points: DayPoint[] = []
  for (const file of conversationFiles(root)) {
    if (!touchedSince(file, since)) continue
    for (const r of readTally(file)?.responses ?? []) {
      if (r.at >= since && r.tps !== null) points.push({ at: r.at, agent: 'antigravity', model: r.model, tps: r.tps, outputTokens: r.outputTokens })
    }
  }
  return points
}
