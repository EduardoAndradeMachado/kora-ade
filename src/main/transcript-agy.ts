import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { SESSION_ID } from '../shared/agent'
import type { TranscriptItem, TranscriptPage, TranscriptStatus } from '../shared/transcript'
import { agyConversationFile, protoFields, withDb } from './antigravity-conversations'
import type { TranscriptCursor } from './transcript-claude'

// Modo leitura das conversas do agy (Antigravity CLI), conferido em 197 conversas gravadas até 2026-11-24. Cada
// passo é uma linha de `steps` (idx contíguo a partir de 0) com o passo inteiro em protobuf no step_payload: 1 tipo,
// 4 status, 5 metadados (igual à coluna metadata: 1 criação, 4 chamada de ferramenta, 7/8 fim) e um campo por tipo.

const TEXT_MAX = 16 * 1024
const RESULT_MAX = 1500
const SUMMARY_MAX = 200
// Uma página percorre no máximo isto de payload: um trecho só de lembretes não prende o main lendo dezenas de MB.
const SCAN_MAX = 8 * 1024 * 1024
const FORWARD_MAX = 4 * 1024 * 1024

const USER_INPUT = 14
const PLANNER_RESPONSE = 15
const ERROR_MESSAGE = 17
const COMPACTION = 23
const NOTIFICATION = 101
const TOOL = 132

const STEP_DONE = 3
// Passos anteriores a um /compact ficam assim: o texto sobra, a saída das ferramentas e as chamadas do modelo somem.
const STEP_CLEARED = 5
const STEP_ERROR = 7
const STEP_RUNNING = 2
// Pendente, rodando, gerando, esperando aprovação e na fila: o passo ainda vai mudar.
const NOT_FINAL = [1, 2, 8, 9, 11]
const STOPPED = new Set([6, 10, 12])

type Fields = ReturnType<typeof protoFields>
type Value = bigint | Uint8Array | undefined

const first = (fields: Fields | null, field: number): Value => fields?.get(field)?.[0]
const sub = (value: Value): Fields | null => {
  if (!(value instanceof Uint8Array)) return null
  try {
    return protoFields(value)
  } catch {
    return null
  }
}
const str = (value: Value): string => (value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '')
const int = (value: Value): number => (typeof value === 'bigint' ? Number(value) : 0)

const clip = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false }
const oneLine = (text: string, max = SUMMARY_MAX): string => clip(text.replace(/\s+/g, ' ').trim(), max).text

// google.protobuf.Timestamp: segundos no 1, nanossegundos no 2.
function millis(value: Value): number | null {
  const t = sub(value)
  const seconds = int(first(t, 1))
  return seconds > 0 ? seconds * 1000 + Math.floor(int(first(t, 2)) / 1e6) : null
}
const iso = (ms: number | null): string => (ms === null ? '' : new Date(ms).toISOString())

// ───────────── cursor ─────────────

// O cursor marca uma fronteira em meios passos: 2·idx é antes do passo idx, 2·idx+1 é entre a chamada de uma
// ferramenta e o resultado dela (a chamada aparece enquanto ela roda ou espera aprovação; o resultado vem depois).
// O /undo e o /rewind do agy apagam os passos do fim e reaproveitam os idx: por isso os 16 bits de baixo levam uma
// impressão do horário de criação do último passo antes da fronteira, e cursor que não bate com o banco pede reset.
const FINGERPRINT = 0x10000

function fingerprint(metadata: Uint8Array | null): number {
  const created = first(sub(metadata ?? undefined), 1)
  const bytes = created instanceof Uint8Array ? created : new Uint8Array()
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash & 0xffff
}

interface Row {
  idx: number
  type: number
  status: number
  payload: Uint8Array | null
}

const toRow = (r: Record<string, unknown>): Row => ({
  idx: Number(r['idx']),
  type: Number(r['step_type']),
  status: Number(r['status']),
  payload: r['step_payload'] instanceof Uint8Array ? r['step_payload'] : null
})

// Passo que contém o último pedaço entregue antes da fronteira b.
const stepBefore = (b: number): number => Math.floor((b - 1) / 2)

function encode(db: DatabaseSync, b: number): number {
  if (b === 0) return 0
  const row = db.prepare('select metadata from steps where idx = ?').get(stepBefore(b)) as { metadata?: unknown } | undefined
  return b * FINGERPRINT + fingerprint(row?.metadata instanceof Uint8Array ? row.metadata : null)
}

/** Fronteira do cursor, ou null quando ele não veio desta conversa como ela está agora. */
function decode(db: DatabaseSync, cursor: number, count: number): number | null {
  if (!Number.isSafeInteger(cursor) || cursor < 0) return null
  const b = Math.floor(cursor / FINGERPRINT)
  if (b === 0) return cursor === 0 ? 0 : null
  if (b > 2 * count) return null
  const row = db.prepare('select metadata from steps where idx = ?').get(stepBefore(b)) as { metadata?: unknown } | undefined
  if (!row) return null
  return fingerprint(row.metadata instanceof Uint8Array ? row.metadata : null) === cursor % FINGERPRINT ? b : null
}

// ───────────── até onde dá para entregar ─────────────

function hasBackground(db: DatabaseSync, idx: number): boolean {
  const row = db.prepare('select step_payload from steps where idx = ?').get(idx) as { step_payload?: unknown } | undefined
  const payload = row?.step_payload
  return payload instanceof Uint8Array && (sub(payload)?.has(148) ?? false)
}

/**
 * Primeira fronteira que ainda não pode ser entregue: o celular só acrescenta itens, então passo que ainda vai mudar
 * fica de fora (a resposta do modelo entra inteira quando termina, não aos pedaços). Duas exceções não seguram o
 * resto da conversa: comando em segundo plano (campo 148), que pode rodar por horas enquanto o modelo segue, e passo
 * que ficou parado antes do último pedido da pessoa (o agy fechou no meio e a conversa seguiu).
 */
function holdPoint(db: DatabaseSync, count: number): number {
  const lastUser = Number((db.prepare('select max(idx) as m from steps where step_type = ?').get(USER_INPUT) as { m: unknown }).m ?? -1)
  const open = db
    .prepare(`select idx, step_type, status from steps where status in (${NOT_FINAL.join(',')}) and idx > ? order by idx`)
    .all(lastUser) as { idx: number; step_type: number; status: number }[]
  for (const r of open) {
    const idx = Number(r.idx)
    if (Number(r.step_type) !== TOOL) return 2 * idx
    if (Number(r.status) === STEP_RUNNING && hasBackground(db, idx)) continue
    return 2 * idx + 1
  }
  return 2 * count
}

// ───────────── passo → itens ─────────────

function toolSummary(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(rawArgs) as unknown
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
  } catch {
    // argumento que não é JSON: fica sem resumo
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof args[key] === 'string' && args[key]) return args[key] as string
    return undefined
  }
  const chosen =
    name === 'run_command' ? pick('toolSummary', 'CommandLine')
      : name === 'grep_search' || name === 'find_by_name' ? pick('Query', 'Pattern', 'toolSummary')
        : pick('Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'Url', 'query', 'Query', 'toolSummary', 'Recipient', 'Role', 'TypeName', 'ToolName', 'Action', 'action', 'Prompt', 'Message', 'text')
  return chosen ? oneLine(chosen) : ''
}

// O que o agy mostra no terminal (140.2.3): 9.1 descrição, 9.2.1 arquivo, 10.3.1 comando e 10.3.4 saída. Sobrevive ao
// /compact, que apaga os argumentos da chamada.
interface Render {
  description: string
  file: string
  command: string
  output: string
}

function renderOf(step: Fields): Render {
  const render = sub(first(sub(first(sub(first(step, 140)), 2)), 3))
  const label = sub(first(render, 9))
  const terminal = sub(first(sub(first(render, 10)), 3))
  let file = str(first(sub(first(label, 2)), 1))
  try {
    if (file.startsWith('file:')) file = fileURLToPath(file)
  } catch {
    // endereço que não é de arquivo local: fica como veio
  }
  return { description: str(first(label, 1)), file, command: str(first(terminal, 1)), output: str(first(terminal, 4)) }
}

const renderSummary = (name: string, render: Render): string =>
  oneLine(name === 'run_command' ? render.description || render.command : render.file || render.description)

// O texto que volta para o modelo começa com o horário da ferramenta: não interessa a quem lê.
const withoutHeader = (text: string): string => text.replace(/^\n*(Created At: [^\n]*\n)?(Completed At: [^\n]*\n)?/, '')

function resultText(step: Fields, status: number, render: Render, background: boolean, settled: boolean): { text: string; error: boolean } {
  if (status === STEP_DONE) return { text: withoutHeader(str(first(sub(first(sub(first(step, 140)), 2)), 1))), error: false }
  if (status === STEP_ERROR) {
    const error = sub(first(step, 31))
    return { text: str(first(error, 3)) || str(first(error, 2)) || 'Falhou.', error: true }
  }
  if (STOPPED.has(status)) return { text: 'Cancelada.', error: true }
  if (status === STEP_CLEARED) return { text: render.output || 'Saída descartada pelo agy.', error: false }
  if (background) return { text: 'Rodando em segundo plano.', error: false }
  return { text: settled ? '(sem resultado gravado)' : '', error: false }
}

function userItems(base: string, at: string, input: Fields | null): TranscriptItem[] {
  const parts = (input?.get(3) ?? []).map((value) => sub(value))
  let command: string | null = null
  const typed: string[] = []
  for (const part of parts) {
    const slash = str(first(sub(first(sub(first(part, 2)), 27)), 1))
    if (slash) command = slash
    typed.push(str(first(part, 1)))
  }
  const rest = typed.join('').trim()
  // Comando de barra sozinho (/compact, /model…) vira nota; com texto (/plan pedido) o balão leva o texto inteiro.
  if (command && !rest) return [{ kind: 'note', id: `${base}:note`, at, text: `/${command}` }]
  const text = (str(first(input, 2)) || (command ? `/${command} ${rest}` : rest)).trim()
  return text ? [{ kind: 'user', id: `${base}:user`, at, ...clip(text, TEXT_MAX), images: 0 }] : []
}

// Lembretes que o agy injeta para o modelo (work_efficiently_reminder e os periódicos) vêm sem título, e o aviso de
// reinício do servidor ao retomar vem com o título genérico "System Message": os dois ficam de fora.
function notification(base: string, at: string, body: Fields | null): TranscriptItem[] {
  const title = oneLine(str(first(sub(first(body, 2)), 1)), 600)
  return title && title !== 'System Message' ? [{ kind: 'note', id: `${base}:note`, at, text: title }] : []
}

interface Parts {
  head: TranscriptItem[]
  tail: TranscriptItem[]
}

/** Itens de um passo. tailReady: o resultado da ferramenta já pode sair (passo final ou que não vai mais segurar). */
function stepParts(row: Row, tailReady: boolean, turnStart: () => number | null): Parts {
  const none: Parts = { head: [], tail: [] }
  if (!row.payload) return none
  const step = sub(row.payload)
  if (!step) return none
  const meta = sub(first(step, 5))
  const created = millis(first(meta, 1))
  const base = String(row.idx)
  const at = iso(created)
  switch (row.type) {
    case USER_INPUT:
      return { ...none, head: userItems(base, at, sub(first(step, 19))) }
    case PLANNER_RESPONSE: {
      const response = sub(first(step, 20))
      const ended = millis(first(meta, 7)) ?? millis(first(meta, 8)) ?? created
      const head: TranscriptItem[] = []
      const text = str(first(response, 1)) || str(first(response, 8))
      if (text.trim()) head.push({ kind: 'assistant', id: `${base}:text`, at: iso(ended), ...clip(text, TEXT_MAX) })
      // Resposta concluída sem pedir ferramenta: o modelo devolveu a vez. As apagadas pelo /compact perderam o
      // campo 7, então não contam.
      if (row.status === STEP_DONE && !response?.has(7)) {
        const start = turnStart()
        head.push({ kind: 'turn', id: `${base}:turn`, at: iso(ended), durationMs: start !== null && ended !== null && ended >= start ? ended - start : null })
      }
      return { head, tail: [] }
    }
    case TOOL: {
      const call = sub(first(meta, 4))
      const toolId = str(first(call, 1))
      const name = str(first(call, 2))
      if (!toolId || !name) return none
      const render = renderOf(step)
      const summary = toolSummary(name, str(first(call, 3))) || renderSummary(name, render)
      const head: TranscriptItem[] = [{ kind: 'tool', id: `${base}:tool`, at, toolId, name, summary }]
      if (!tailReady) return { head, tail: [] }
      const background = row.status === STEP_RUNNING && step.has(148)
      const { text, error } = resultText(step, row.status, render, background, NOT_FINAL.includes(row.status))
      const ended = millis(first(meta, 8)) ?? created
      return { head, tail: [{ kind: 'result', id: `${base}:result`, at: iso(ended), toolId, ...clip(text, RESULT_MAX), error }] }
    }
    case NOTIFICATION:
      return { ...none, head: notification(base, at, sub(first(step, 114))) }
    case ERROR_MESSAGE: {
      const message = oneLine(str(first(sub(first(sub(first(step, 24)), 3)), 1)), 600)
      return { ...none, head: message ? [{ kind: 'note', id: `${base}:note`, at, text: `Erro do agy: ${message}` }] : [] }
    }
    case COMPACTION:
      return row.status === STEP_DONE ? { ...none, head: [{ kind: 'note', id: `${base}:note`, at, text: 'Conversa compactada' }] } : none
    default:
      return none
  }
}

// O turno conta a partir do último pedido da pessoa antes da resposta (índice em step_type: busca direta).
function turnStartReader(db: DatabaseSync): (before: number) => number | null {
  const statement = db.prepare('select metadata from steps where step_type = ? and idx < ? order by idx desc limit 1')
  const cache = new Map<number, number | null>()
  return (before) => {
    if (cache.has(before)) return cache.get(before)!
    const row = statement.get(USER_INPUT, before) as { metadata?: unknown } | undefined
    const at = row?.metadata instanceof Uint8Array ? millis(first(sub(row.metadata), 1)) : null
    cache.set(before, at)
    return at
  }
}

const countable = (items: TranscriptItem[]): number => items.filter((item) => item.kind !== 'result').length

// ───────────── status ─────────────

interface ModelName {
  model?: string
  effort?: string
}
// Código do modelo → nome, por conversa: o mesmo código vale nomes diferentes em conversas diferentes, e o nome
// mora na linha de gen_metadata, que carrega o prompt inteiro (até MBs).
const modelNames = new Map<string, Map<number, ModelName>>()
const MAX_CONVERSATIONS = 64

function modelName(db: DatabaseSync, file: string, code: number, generation: number): ModelName {
  let names = modelNames.get(file)
  const known = names?.get(code)
  if (known) return known
  let found: ModelName = {}
  try {
    const row = db.prepare('select data from gen_metadata where idx = ?').get(generation) as { data?: unknown } | undefined
    const request = row?.data instanceof Uint8Array ? sub(first(sub(row.data), 1)) : null
    // 19 é o modelo (gemini-4-hydrogen), 21 o nome mostrado com o nível de raciocínio ("Gemini 4 Hydrogen (High)").
    const model = str(first(request, 19))
    const display = str(first(request, 21))
    const effort = display.match(/\(([^)]+)\)\s*$/)?.[1]
    found = { ...(model || display ? { model: model || display.replace(/\s*\([^)]*\)\s*$/, '') } : {}), ...(effort ? { effort: effort.toLowerCase() } : {}) }
  } catch {
    // tabela ou formato ausente: a barra fica sem o modelo
  }
  // Sem nome não guarda: a linha pode ainda não ter sido gravada, a próxima página tenta de novo.
  if (!found.model) return found
  if (!names) {
    names = new Map()
    modelNames.set(file, names)
    if (modelNames.size > MAX_CONVERSATIONS) modelNames.delete(modelNames.keys().next().value!)
  }
  names.set(code, found)
  return found
}

// Pela última resposta concluída: código do modelo no 11 (ou 9.1), linha do gen_metadata no 20.3 (a primeira resposta
// não grava, é a linha 0) e uso no 9 (2 entrada sem cache, 5 cache lido). O agy não grava a janela nem o modo de
// aprovação na conversa.
function readStatus(db: DatabaseSync, file: string): TranscriptStatus | undefined {
  const row = db
    .prepare('select metadata from steps where step_type = ? and status = ? order by idx desc limit 1')
    .get(PLANNER_RESPONSE, STEP_DONE) as { metadata?: unknown } | undefined
  const meta = row?.metadata instanceof Uint8Array ? sub(row.metadata) : null
  if (!meta) return undefined
  const usage = sub(first(meta, 9))
  const code = first(meta, 11) ?? first(usage, 1)
  const generation = sub(first(meta, 20))
  const status: TranscriptStatus = typeof code === 'bigint' ? { ...modelName(db, file, Number(code), int(first(generation, 3))) } : {}
  if (usage && (usage.has(2) || usage.has(5))) status.contextTokens = int(first(usage, 2)) + int(first(usage, 5))
  return Object.keys(status).length > 0 ? status : undefined
}

// ───────────── páginas ─────────────

const empty = (sessionId: string): TranscriptPage => ({ sessionId, items: [], start: 0, end: 0, atStart: true })

function stepCount(db: DatabaseSync): number {
  const m = (db.prepare('select max(idx) as m from steps').get() as { m: unknown }).m
  return m === null || m === undefined ? 0 : Number(m) + 1
}

function readRow(db: DatabaseSync, idx: number): Row | null {
  const r = db.prepare('select idx, step_type, status, step_payload from steps where idx = ?').get(idx) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

function pageBefore(db: DatabaseSync, sessionId: string, before: number | undefined, limit: number, file: string): TranscriptPage {
  const count = stepCount(db)
  const hold = holdPoint(db, count)
  const b = before === undefined ? hold : decode(db, before, count)
  if (b === null || b > hold) return { ...empty(sessionId), reset: true }
  const turnStart = turnStartReader(db)
  const items: TranscriptItem[] = []
  let counted = 0
  let pos = b
  // Fronteira no meio de um passo: só a chamada da ferramenta, o resultado ainda não saiu.
  if (pos % 2 === 1) {
    const row = readRow(db, stepBefore(pos))
    if (row) {
      const parts = stepParts(row, false, () => turnStart(row.idx))
      items.unshift(...parts.head)
      counted += countable(parts.head)
    }
    pos -= 1
  }
  let scanned = 0
  const rows = db.prepare('select idx, step_type, status, step_payload from steps where idx < ? order by idx desc').iterate(pos / 2)
  for (const raw of rows) {
    if (counted >= limit || (scanned >= SCAN_MAX && pos < b)) break
    const row = toRow(raw as Record<string, unknown>)
    scanned += row.payload?.length ?? 0
    const parts = stepParts(row, true, () => turnStart(row.idx))
    const stepItems = [...parts.head, ...parts.tail]
    items.unshift(...stepItems)
    counted += countable(stepItems)
    pos = 2 * row.idx
  }
  return { sessionId, items, start: encode(db, pos), end: encode(db, b), atStart: pos === 0, status: readStatus(db, file) }
}

function pageAfter(db: DatabaseSync, sessionId: string, after: number, file: string): TranscriptPage {
  const count = stepCount(db)
  const b = decode(db, after, count)
  if (b === null) return { ...empty(sessionId), reset: true }
  const hold = holdPoint(db, count)
  const turnStart = turnStartReader(db)
  const items: TranscriptItem[] = []
  let pos = b
  if (pos % 2 === 1) {
    if (pos >= hold) return { sessionId, items, start: after, end: after, atStart: b === 0, status: readStatus(db, file) }
    const row = readRow(db, stepBefore(pos))
    if (row) items.push(...stepParts(row, true, () => turnStart(row.idx)).tail)
    pos += 1
  }
  let read = 0
  const rows = db.prepare('select idx, step_type, status, step_payload from steps where idx >= ? order by idx').iterate(pos / 2)
  for (const raw of rows) {
    const row = toRow(raw as Record<string, unknown>)
    if (2 * row.idx >= hold || read >= FORWARD_MAX) break
    read += row.payload?.length ?? 0
    const ready = 2 * row.idx + 1 < hold
    const parts = stepParts(row, ready, () => turnStart(row.idx))
    items.push(...parts.head)
    pos = 2 * row.idx + 1
    if (!ready) break
    items.push(...parts.tail)
    pos += 1
  }
  return { sessionId, items, start: after, end: encode(db, pos), atStart: b === 0, status: readStatus(db, file) }
}

/**
 * Página da conversa do agy. Sem before nem after: as últimas `limit` mensagens. Banco ausente é página vazia
 * (conversa nova); banco que existe mas não abre agora (travado, no meio de um checkpoint) lança, para o celular
 * tentar de novo sem perder o cursor.
 */
export async function agyTranscriptPage(root: string, conversationId: string, cursor: TranscriptCursor): Promise<TranscriptPage> {
  if (!SESSION_ID.test(conversationId)) return empty(conversationId)
  const file = agyConversationFile(root, conversationId)
  if (!existsSync(file)) return cursor.after !== undefined && cursor.after !== 0 ? { ...empty(conversationId), reset: true } : empty(conversationId)
  const page = withDb(file, (db) =>
    cursor.after !== undefined ? pageAfter(db, conversationId, cursor.after, file) : pageBefore(db, conversationId, cursor.before, cursor.limit, file)
  )
  if (!page) throw new Error('Não deu para ler a conversa do Antigravity agora.')
  return page
}
