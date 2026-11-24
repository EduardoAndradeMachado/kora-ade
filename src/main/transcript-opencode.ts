import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { OPENCODE_SESSION_ID } from '../shared/agent'
import type { TranscriptItem, TranscriptPage, TranscriptStatus } from '../shared/transcript'
import type { TranscriptCursor } from './transcript-claude'

const TEXT_MAX = 16 * 1024
const RESULT_MAX = 1500
const SUMMARY_MAX = 200
// Uma página para trás percorre no máximo isto: um trecho só de linhas sem conversa (avisos de instrução, troca de
// modelo) não prende o main. A página volta com menos itens e o celular pede a próxima.
const SCAN_ROWS = 400
const BATCH_ROWS = 100
const FORWARD_ROWS = 500

// Cursor = seq da linha em session_message × STRIDE + posição dentro dela: "tudo antes deste ponto já foi entregue".
// O seq é a ordem de gravação da sessão (único, só cresce, não muda quando a linha é atualizada) e tem buracos, que
// não atrapalham. A posição existe porque o OpenCode grava cada passo do assistente numa linha só e a reescreve
// enquanto o passo anda: o celular recebe as chamadas assim que o modelo termina de escrevê-las e cada resultado
// quando a ferramenta acaba, sem esperar o passo inteiro. Texto e chamadas ocupam 0..n-1 (na ordem das partes), os
// resultados RESULT_BASE+i e as notas de erro TAIL. Linha inteira entregue = (seq + 1) × STRIDE.
const STRIDE = 4096
const RESULT_BASE = 2048
const TAIL = STRIDE - 1

type Data = Record<string, unknown>
interface Row { id: string; seq: number; type: string; time_created: number; data: string }
interface Part { type?: string; id?: string; name?: string; text?: string; time?: { created?: number; completed?: number }; state?: ToolState }
interface ToolState { status?: string; input?: unknown; content?: unknown; error?: { type?: string; message?: string }; metadata?: Data }
// Unidade entregue de uma vez. settled = não muda mais; a leitura para na primeira que ainda pode mudar.
interface Unit { pos: number; settled: boolean; items: TranscriptItem[] }

const clip = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false }

const oneLine = (text: string, max = SUMMARY_MAX): string => clip(text.replace(/\s+/g, ' ').trim(), max).text

const MAX_DATE_MS = 8.64e15
const iso = (ms: unknown, fallback: number): string => {
  const value = typeof ms === 'number' && Math.abs(ms) <= MAX_DATE_MS ? ms : fallback
  return Math.abs(value) <= MAX_DATE_MS ? new Date(value).toISOString() : ''
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Data
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) if (str(i[key])) return i[key] as string
    return undefined
  }
  let chosen: string | undefined
  if (name === 'shell' || name === 'bash') chosen = pick('description', 'command')
  else if (name === 'grep' || name === 'glob') chosen = pick('pattern')
  else if (name === 'subagent' || name === 'task') {
    const what = pick('description', 'prompt')
    const agent = pick('agent', 'subagent_type')
    chosen = what && agent ? `${agent}: ${what}` : what
  } else if (name === 'question') chosen = Array.isArray(i['questions']) ? str((i['questions'][0] as Data | undefined)?.['question']) : undefined
  else if (name === 'todowrite') chosen = Array.isArray(i['todos']) ? `${i['todos'].length} tarefas` : undefined
  else chosen = pick('path', 'filePath', 'file', 'url', 'query', 'name', 'id', 'description', 'command', 'code', 'prompt')
  return chosen ? oneLine(chosen) : ''
}

function resultText(state: ToolState): string {
  if (state.status === 'error') return state.error?.message ?? ''
  if (!Array.isArray(state.content)) return ''
  return (state.content as { type?: string; text?: string; mime?: string }[])
    .map((c) => (c.type === 'text' ? c.text ?? '' : c.type === 'file' ? (c.mime?.startsWith('image/') ? '[imagem]' : '[arquivo]') : ''))
    .filter(Boolean)
    .join('\n')
}

const TERMINAL = new Set(['completed', 'error'])

function assistantUnits(row: Row, d: Data, final: boolean): Unit[] {
  const time = (d['time'] ?? {}) as { completed?: unknown; streamed?: unknown }
  const error = d['error'] as { type?: string; message?: string } | undefined
  const done = final || typeof time.completed === 'number' || error !== undefined
  // Enquanto o modelo escreve, o OpenCode grava as partes como esboço (texto vazio, entrada da ferramenta pela
  // metade) e só as preenche no fim do streaming. Até lá nada da linha sai, e o cursor para no começo dela.
  if (!done && typeof time.streamed !== 'number') return [{ pos: 0, settled: false, items: [] }]
  const parts = (Array.isArray(d['content']) ? (d['content'] as Part[]) : []).slice(0, RESULT_BASE)
  const units: Unit[] = []
  parts.forEach((p, index) => {
    const at = iso(p.time?.created, row.time_created)
    const id = `${row.id}:${index}`
    const items: TranscriptItem[] =
      p.type === 'text' && p.text?.trim() ? [{ kind: 'assistant', id, at, ...clip(p.text, TEXT_MAX) }]
        : p.type === 'tool' && p.name ? [{ kind: 'tool', id, at, toolId: p.id ?? id, name: p.name, summary: toolSummary(p.name, p.state?.input) }]
          : []
    units.push({ pos: index, settled: true, items })
  })
  // Depois do streaming as ferramentas rodam: a chamada já saiu acima, o resultado sai quando cada uma termina.
  parts.forEach((p, index) => {
    if (p.type !== 'tool' || !p.name) return
    const state = p.state ?? {}
    const terminal = TERMINAL.has(state.status ?? '')
    const base = { kind: 'result' as const, id: `${row.id}:${index}:result`, at: iso(p.time?.completed, row.time_created), toolId: p.id ?? `${row.id}:${index}` }
    const exit = state.metadata?.['exit']
    const result: TranscriptItem = terminal
      ? { ...base, ...clip(resultText(state), RESULT_MAX), error: state.status === 'error' || (typeof exit === 'number' && exit !== 0) }
      // Passo encerrado com a ferramenta ainda aberta (interrompido, OpenCode fechado no meio).
      : { ...base, text: 'A ferramenta não terminou.', error: true, truncated: false }
    units.push({ pos: RESULT_BASE + index, settled: done || terminal, items: [result] })
  })
  const tail: TranscriptItem[] = []
  // Interrupção vem como nota pela linha idle; aqui só os erros do provedor (cota, autenticação, rede).
  if (error && error.type !== 'aborted') tail.push({ kind: 'note', id: `${row.id}:note`, at: iso(undefined, row.time_created), text: oneLine(error.message || error.type || 'Erro', 600) })
  else if (d['finish'] === 'length') tail.push({ kind: 'note', id: `${row.id}:note`, at: iso(undefined, row.time_created), text: 'Resposta cortada no limite de tokens do modelo' })
  units.push({ pos: TAIL, settled: done, items: tail })
  return units
}

interface Context {
  final: (row: Row) => boolean
  turnStart: (idleSeq: number) => number | null
}

function rowUnits(row: Row, ctx: Context): Unit[] {
  let d: Data
  try {
    d = JSON.parse(row.data) as Data
  } catch {
    return [{ pos: 0, settled: true, items: [] }]
  }
  const at = iso((d['time'] as { created?: unknown } | undefined)?.created, row.time_created)
  const one = (items: TranscriptItem[], settled = true): Unit[] => [{ pos: 0, settled, items }]
  const note = (text: string): TranscriptItem => ({ kind: 'note', id: row.id, at, text })
  switch (row.type) {
    case 'user': {
      const files = Array.isArray(d['files']) ? (d['files'] as { mime?: string }[]) : []
      const images = files.filter((f) => typeof f.mime === 'string' && f.mime.startsWith('image/')).length
      const text = typeof d['text'] === 'string' ? d['text'].trim() : ''
      return one(text || images ? [{ kind: 'user', id: `${row.id}:user`, at, ...clip(text, TEXT_MAX), images }] : [])
    }
    case 'assistant':
      return assistantUnits(row, d, ctx.final(row))
    case 'idle': {
      const items: TranscriptItem[] = []
      if (d['outcome'] === 'interrupted') items.push({ kind: 'note', id: `${row.id}:note`, at, text: 'Interrompido' })
      const start = ctx.turnStart(row.seq)
      const end = (d['time'] as { created?: unknown } | undefined)?.created
      const durationMs = start !== null && typeof end === 'number' && end >= start ? end - start : null
      items.push({ kind: 'turn', id: `${row.id}:turn`, at, durationMs })
      return one(items)
    }
    case 'compaction': {
      const status = d['status']
      const settled = status === 'completed' || status === 'failed' || ctx.final(row)
      if (status === 'failed') return one([note('A compactação da conversa falhou')], settled)
      return one([note(d['reason'] === 'auto' ? 'Conversa compactada automaticamente' : 'Conversa compactada')], settled)
    }
    case 'synthetic': {
      // Só o que avisa a pessoa de algo que terminou; o resto (instruções carregadas, lembretes) é para o modelo.
      const meta = (d['metadata'] ?? {}) as Data
      const description = str(d['description']) ? oneLine(d['description'] as string) : ''
      if (meta['source'] === 'shell') {
        const exit = meta['exit']
        return one([note(`Comando em segundo plano terminou${typeof exit === 'number' && exit !== 0 ? ` com erro (saída ${exit})` : ''}${description ? `: ${description}` : ''}`)])
      }
      if (meta['source'] === 'subagent') return one([note(`Subagente terminou${description ? `: ${description}` : ''}`)])
      return one([])
    }
    case 'agent-switched':
      return one(str(d['agent']) ? [note(`Agente: ${d['agent'] as string}`)] : [])
    case 'model-switched': {
      const model = (d['model'] ?? {}) as { id?: unknown; variant?: unknown }
      return one(str(model.id) ? [note(`Modelo: ${model.id as string}${str(model.variant) ? ` (${model.variant as string})` : ''}`)] : [])
    }
    default:
      return one([])
  }
}

const empty = (sessionId: string): TranscriptPage => ({ sessionId, items: [], start: 0, end: 0, atStart: true })
const reset = (sessionId: string): TranscriptPage => ({ ...empty(sessionId), reset: true })

interface SessionRow { agent?: unknown; model?: unknown; time_busy?: unknown; time_idle?: unknown }

function sessionOf(db: DatabaseSync, sessionId: string): SessionRow | null {
  try {
    return (db.prepare('select agent, model, time_busy, time_idle from session_v2 where id = ?').get(sessionId) as SessionRow | undefined) ?? null
  } catch {
    // Esquema sem time_busy/time_idle: sem saber se a sessão está ocupada, só uma linha mais nova encerra um passo.
    return (db.prepare('select agent, model from session_v2 where id = ?').get(sessionId) as SessionRow | undefined) ?? null
  }
}

function statusOf(session: SessionRow): TranscriptStatus {
  const status: TranscriptStatus = {}
  if (str(session.agent)) status.mode = session.agent as string
  try {
    const model = JSON.parse(String(session.model)) as { id?: unknown; variant?: unknown }
    if (str(model.id)) status.model = model.id as string
    if (str(model.variant) && model.variant !== 'default') status.effort = model.variant as string
  } catch {
    // Sem modelo gravado na sessão: a barra fica com o das métricas.
  }
  return status
}

const hasTables = (db: DatabaseSync): boolean =>
  (db.prepare("select count(*) as n from sqlite_master where type = 'table' and name in ('session_v2', 'session_message')").get() as { n: number }).n === 2

function withDb<T>(dbFile: string, read: (db: DatabaseSync) => T, absent: () => T): T {
  if (!dbFile || !existsSync(dbFile)) return absent()
  // Conexão própria, só leitura, fechada no fim: nada segura o arquivo do OpenCode entre uma página e outra. A
  // transação dá às consultas da página uma foto única do banco, mesmo com o OpenCode gravando no meio.
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    if (!hasTables(db)) return absent()
    db.exec('begin')
    try {
      return read(db)
    } finally {
      db.exec('commit')
    }
  } finally {
    db.close()
  }
}

function pageOf(db: DatabaseSync, sessionId: string, cursor: TranscriptCursor): TranscriptPage {
  const session = sessionOf(db, sessionId)
  const given = cursor.after ?? cursor.before
  if (!session) return given !== undefined && given > 0 ? reset(sessionId) : empty(sessionId)
  const status = statusOf(session)
  const busy = session.time_busy === undefined || (typeof session.time_busy === 'number' && session.time_busy > (typeof session.time_idle === 'number' ? session.time_idle : 0))

  const get = <T>(sql: string, ...params: (string | number)[]): T | undefined => db.prepare(sql).get(...params) as T | undefined
  const maxSeq = get<{ m: number | null }>('select max(seq) as m from session_message where session_id = ?', sessionId)?.m ?? null
  const lastStep = get<{ m: number | null }>("select max(seq) as m from session_message where session_id = ? and type in ('assistant', 'idle')", sessionId)?.m ?? null
  const limitCursor = maxSeq === null ? 0 : (maxSeq + 1) * STRIDE

  if (given !== undefined) {
    if (!Number.isSafeInteger(given) || given < 0 || given > limitCursor) return reset(sessionId)
    // Cursor no meio de uma linha que não existe mais: a conversa foi reescrita.
    if (given % STRIDE !== 0 && !get('select 1 from session_message where session_id = ? and seq = ?', sessionId, Math.floor(given / STRIDE))) return reset(sessionId)
  }

  const ctx: Context = {
    // Passo do assistente acaba quando grava completed, quando outro passo (ou o idle) entra depois dele, ou quando a
    // sessão não está mais ocupada (OpenCode fechado no meio do passo).
    final: (row) => !busy || (row.type === 'assistant' ? lastStep !== null && row.seq < lastStep : maxSeq !== null && row.seq < maxSeq),
    // O turno começa na mensagem da pessoa ou no aviso (comando em segundo plano, subagente) que acordou o agente.
    turnStart: (idleSeq) => {
      const previous = get<{ m: number | null }>("select max(seq) as m from session_message where session_id = ? and type = 'idle' and seq < ?", sessionId, idleSeq)?.m ?? -1
      return get<{ t: number }>("select time_created as t from session_message where session_id = ? and type in ('user', 'synthetic') and seq > ? and seq < ? order by seq limit 1", sessionId, previous, idleSeq)?.t ?? null
    }
  }
  const page = cursor.after !== undefined ? forward(db, sessionId, cursor.after, ctx) : backward(db, sessionId, cursor.before, cursor.limit, ctx, maxSeq)
  return { ...page, status }
}

const rowsSql = 'select id, seq, type, time_created, data from session_message where session_id = ?'

function forward(db: DatabaseSync, sessionId: string, after: number, ctx: Context): TranscriptPage {
  const fromSeq = Math.floor(after / STRIDE)
  const fromPos = after % STRIDE
  const rows = db.prepare(`${rowsSql} and seq >= ? order by seq limit ?`).all(sessionId, fromSeq, FORWARD_ROWS) as unknown as Row[]
  const items: TranscriptItem[] = []
  let end = after
  for (const row of rows) {
    for (const unit of rowUnits(row, ctx)) {
      if (row.seq === fromSeq && unit.pos < fromPos) continue
      if (!unit.settled) return { sessionId, items, start: after, end: row.seq * STRIDE + unit.pos, atStart: after === 0 }
      items.push(...unit.items)
    }
    end = (row.seq + 1) * STRIDE
  }
  return { sessionId, items, start: after, end, atStart: after === 0 }
}

function backward(db: DatabaseSync, sessionId: string, before: number | undefined, limit: number, ctx: Context, maxSeq: number | null): TranscriptPage {
  const bound = before ?? (maxSeq === null ? 0 : (maxSeq + 1) * STRIDE)
  const boundSeq = Math.floor(bound / STRIDE)
  const boundPos = bound % STRIDE
  let end = bound
  // Itens de cada linha lida, da mais nova para a mais antiga.
  let taken: TranscriptItem[][] = []
  let counted = 0
  let scanned = 0
  let below = boundPos > 0 ? boundSeq + 1 : boundSeq
  const batch = db.prepare(`${rowsSql} and seq < ? order by seq desc limit ?`)
  while (counted < limit && scanned < SCAN_ROWS) {
    const rows = batch.all(sessionId, below, BATCH_ROWS) as unknown as Row[]
    if (rows.length === 0) break
    for (const row of rows) {
      if (counted >= limit || scanned >= SCAN_ROWS) break
      scanned++
      below = row.seq
      const items: TranscriptItem[] = []
      for (const unit of rowUnits(row, ctx)) {
        if (row.seq === boundSeq && boundPos > 0 && unit.pos >= boundPos) break
        // Na página mais nova, a primeira unidade que ainda pode mudar fecha o end: ela e o que vem depois chegam pelo after.
        if (before === undefined && !unit.settled) {
          taken = []
          counted = 0
          end = row.seq * STRIDE + unit.pos
          break
        }
        items.push(...unit.items)
      }
      taken.push(items)
      // Resultado vai junto da chamada, que já conta: senão uma página de ferramentas não teria conversa.
      counted += items.filter((item) => item.kind !== 'result').length
    }
  }
  const atStart = !db.prepare('select 1 from session_message where session_id = ? and seq < ? limit 1').get(sessionId, below)
  return { sessionId, items: taken.reverse().flat(), start: atStart ? 0 : below * STRIDE, end, atStart }
}

export async function opencodeTranscriptPage(dbFile: string, sessionId: string, cursor: TranscriptCursor): Promise<TranscriptPage> {
  if (!OPENCODE_SESSION_ID.test(sessionId)) return empty(sessionId)
  return withDb(dbFile, (db) => pageOf(db, sessionId, cursor), () => {
    const given = cursor.after ?? cursor.before
    return given !== undefined && given > 0 ? reset(sessionId) : empty(sessionId)
  })
}
