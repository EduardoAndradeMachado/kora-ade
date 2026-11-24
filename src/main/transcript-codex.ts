import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { TranscriptItem, TranscriptPage, TranscriptStatus } from '../shared/transcript'
import type { TranscriptCursor } from './transcript-claude'

const TEXT_MAX = 16 * 1024
const RESULT_MAX = 1500
const SUMMARY_MAX = 200
const CHUNK_BYTES = 256 * 1024
// O rollout é dominado por linhas que a leitura descarta (raciocínio, tokens, a cópia de cada saída para o modelo,
// imagens em base64): uma página percorre no máximo isto e volta com menos itens, e o celular pede a próxima.
const SCAN_MAX = 8 * 1024 * 1024
const FORWARD_MAX = 4 * 1024 * 1024
// Até onde a primeira página procura o turn_context em vigor quando o turno atual não coube nela.
const STATUS_SCAN_MAX = 8 * 1024 * 1024
const NEWLINE = 0x0a
const TURN_CONTEXT = Buffer.from('"type":"turn_context"')

type Entry = Record<string, unknown>
type Item = Record<string, unknown>
type Parse = (line: Buffer, offset: number) => TranscriptItem[]

const clip = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false }

const oneLine = (text: string, max = SUMMARY_MAX): string => clip(text.replace(/\s+/g, ' ').trim(), max).text

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const result = (id: string, at: string, toolId: string, text: string, error: boolean): TranscriptItem =>
  ({ kind: 'result', id: `${id}:result`, at, toolId, ...clip(text, RESULT_MAX), error })

const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function localPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

function firstString(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value
  if (depth > 4 || !value || typeof value !== 'object') return ''
  for (const inner of Object.values(value)) {
    const found = firstString(inner, depth + 1)
    if (found) return found
  }
  return ''
}

function commandText(item: Item): string {
  const parsed = Array.isArray(item['parsed_cmd']) ? (item['parsed_cmd'] as Item[]).map((c) => str(c['cmd'])).filter(Boolean) : []
  if (parsed.length) return parsed.join(' && ')
  const command = item['command']
  // ["powershell.exe", "-Command", "<script>"]: o que o agente escreveu é o último pedaço.
  if (Array.isArray(command)) return str(command[command.length - 1])
  return str(command)
}

function mcpText(value: unknown): string {
  const content = (value as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return (content as Item[]).map((b) => (b['type'] === 'text' ? str(b['text']) : b['type'] === 'image' ? '[imagem]' : '')).filter(Boolean).join('\n')
}

// Itens que a tela do Codex mostra (os ThreadItem do app-server, gravados como event_msg/item_completed). Toda
// ferramenta sai com o resultado junto: o item só é gravado quando ela termina.
function completedItems(id: string, at: string, item: Item): TranscriptItem[] {
  const toolId = str(item['id']) || id
  const tool = (name: string, summary: string): TranscriptItem => ({ kind: 'tool', id, at, toolId, name, summary: oneLine(summary) })
  switch (item['type']) {
    case 'UserMessage': {
      const content = Array.isArray(item['content']) ? (item['content'] as Item[]) : []
      const text = content.filter((c) => c['type'] === 'text').map((c) => str(c['text'])).join('\n\n').trim()
      const images = content.filter((c) => c['type'] === 'image' || c['type'] === 'local_image').length
      return text || images ? [{ kind: 'user', id, at, ...clip(text, TEXT_MAX), images }] : []
    }
    case 'AgentMessage': {
      const content = Array.isArray(item['content']) ? (item['content'] as Item[]) : []
      const text = content.map((c) => str(c['text'])).join('\n\n')
      return text.trim() ? [{ kind: 'assistant', id, at, ...clip(text, TEXT_MAX) }] : []
    }
    case 'CommandExecution': {
      const exit = item['exit_code']
      const status = item['status']
      const failedExit = typeof exit === 'number' && exit !== 0
      const output = str(item['aggregated_output']).trimEnd()
      const text = failedExit ? `${output}${output ? '\n' : ''}[código de saída ${exit}]` : output
      return [tool('shell', commandText(item)), result(id, at, toolId, text, failedExit || status === 'failed' || status === 'declined')]
    }
    case 'FileChange': {
      const changes = item['changes'] && typeof item['changes'] === 'object' ? Object.keys(item['changes']) : []
      const text = [str(item['stdout']), str(item['stderr'])].map((s) => s.trim()).filter(Boolean).join('\n')
      return [tool('apply_patch', changes.map(fileName).join(', ')), result(id, at, toolId, text, item['status'] !== 'completed')]
    }
    case 'McpToolCall': {
      const value = item['result'] as { isError?: unknown } | null | undefined
      const error = item['error'] as { message?: unknown } | null | undefined
      const text = mcpText(value) || str(error?.message)
      const name = [str(item['server']), str(item['tool'])].filter(Boolean).join('.')
      return [tool(name || 'mcp', firstString(item['arguments'])), result(id, at, toolId, text, item['status'] === 'failed' || value?.isError === true || !!error)]
    }
    case 'ImageView':
      return [tool('view_image', localPath(str(item['path']))), result(id, at, toolId, '', false)]
    case 'Extension': {
      if (item['kind'] !== 'web.search') return []
      const action = item['action'] as { queries?: unknown } | undefined
      const queries = Array.isArray(action?.queries) ? (action.queries as unknown[]).map(str).filter(Boolean) : []
      const results = Array.isArray(item['results']) ? (item['results'] as Item[]) : []
      const text = results.map((r) => [str(r['title']), str(r['url'])].filter(Boolean).join(' — ')).filter(Boolean).join('\n')
      return [tool('web_search', str(item['query']) || queries.join(' | ')), result(id, at, toolId, text, false)]
    }
    case 'SubAgentActivity': {
      const name = fileName(str(item['agent_path'])) || 'subagente'
      const verb = item['kind'] === 'started' ? 'começou' : item['kind'] === 'completed' ? 'terminou' : item['kind'] === 'interrupted' ? 'foi interrompido' : null
      return verb ? [{ kind: 'note', id, at, text: `Subagente ${name} ${verb}` }] : []
    }
    case 'EnteredReviewMode':
      return [{ kind: 'note', id, at, text: 'Revisão começou' }]
    case 'ExitedReviewMode':
      return [{ kind: 'note', id, at, text: 'Revisão terminou' }]
  }
  return []
}

function turnDuration(p: Entry): number | null {
  if (typeof p['duration_ms'] === 'number') return p['duration_ms']
  // Sem duration_ms, started_at e completed_at vêm em segundos.
  if (typeof p['started_at'] === 'number' && typeof p['completed_at'] === 'number') return (p['completed_at'] - p['started_at']) * 1000
  return null
}

// Uma linha do rollout vira zero ou mais itens. A conversa sai só dos eventos (event_msg), que são o que a tela do
// Codex mostra: os response_item repetem as mesmas mensagens e ferramentas no formato que vai para o modelo, com as
// instruções e o contexto injetados, e o exec do modo código chega lá como um script inteiro. O formato não é
// documentado e muda entre versões: o que não for reconhecido é ignorado, nunca derruba a leitura.
export function codexItems(entry: Entry, id: string): TranscriptItem[] {
  const at = str(entry['timestamp'])
  const p = (entry['payload'] ?? {}) as Entry
  if (entry['type'] === 'compacted') return [{ kind: 'note', id, at, text: 'Conversa compactada' }]
  if (entry['type'] !== 'event_msg') return []
  switch (p['type']) {
    case 'item_completed':
      return p['item'] && typeof p['item'] === 'object' ? completedItems(id, at, p['item'] as Item) : []
    // Versões sem item_completed (e a revisão de código, que roda numa conversa à parte) gravam só estes dois.
    case 'user_message': {
      const images = (Array.isArray(p['images']) ? p['images'].length : 0) + (Array.isArray(p['local_images']) ? p['local_images'].length : 0)
      const text = str(p['message']).trim()
      return text || images ? [{ kind: 'user', id, at, ...clip(text, TEXT_MAX), images }] : []
    }
    case 'agent_message':
      return str(p['message']).trim() ? [{ kind: 'assistant', id, at, ...clip(str(p['message']), TEXT_MAX) }] : []
    case 'task_complete': {
      const error = p['error'] as { message?: unknown } | null | undefined
      const turn: TranscriptItem = { kind: 'turn', id, at, durationMs: turnDuration(p) }
      return error ? [{ kind: 'note', id: `${id}:error`, at, text: oneLine(`Erro: ${str(error.message) || 'o turno falhou'}`, 600) }, turn] : [turn]
    }
    case 'turn_aborted': {
      const reason = str(p['reason'])
      const text = reason === 'interrupted' || !reason ? 'Interrompido' : `Turno encerrado (${reason})`
      return [{ kind: 'note', id: `${id}:note`, at, text }, { kind: 'turn', id, at, durationMs: turnDuration(p) }]
    }
  }
  return []
}

// A linha começa com {"timestamp":"…","ordinal":N,"type":"…": dá para descartar response_item (a maior parte dos
// bytes, com imagens em base64) sem interpretar o JSON. Só campos simples antes do type; outro formato cai na
// leitura completa.
const HEAD = /^\{(?:"[a-z_]+":(?:"[^"\\]*"|-?\d+),)*"type":"([a-z_]+)"/
const READ_TYPES = new Set(['event_msg', 'compacted', 'turn_context'])

function parseEntry(line: Buffer): Entry | null {
  if (line.length === 0) return null
  const head = HEAD.exec(line.subarray(0, 96).toString('latin1'))
  if (head && !READ_TYPES.has(head[1]!)) return null
  try {
    const entry = JSON.parse(line.toString('utf8')) as unknown
    return entry && typeof entry === 'object' ? (entry as Entry) : null
  } catch {
    return null
  }
}

type Handle = Awaited<ReturnType<typeof open>>

// Cursor que não cai num começo de linha não veio desta leitura (ou o arquivo foi reescrito por baixo).
async function lineStart(handle: Handle, offset: number, size: number): Promise<boolean> {
  if (offset === 0) return true
  if (offset > size) return false
  const byte = Buffer.alloc(1)
  await handle.read(byte, 0, 1, offset - 1)
  return byte[0] === NEWLINE
}

const empty = (sessionId: string): TranscriptPage => ({ sessionId, items: [], start: 0, end: 0, atStart: true })

async function openRollout(file: string): Promise<Handle | null> {
  try {
    return await open(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// Página que termina em `before` (ou no fim do arquivo), lida de trás para frente até juntar `limit` itens.
// A última linha sem quebra está sendo escrita agora: fica de fora, e o end para antes dela.
async function pageBefore(handle: Handle, sessionId: string, before: number | undefined, limit: number, parse: Parse): Promise<TranscriptPage> {
  const { size } = await handle.stat()
  if (before !== undefined && !(await lineStart(handle, before, size))) return { ...empty(sessionId), reset: true }
  let pos = before ?? size
  // pending: bytes de pos até cursor, ainda não lidos como linha. cursor é sempre começo de linha.
  let pending = Buffer.alloc(0)
  let scanned = 0
  let end = pos
  let cursor = pos
  // Lê blocos para trás até um que traga uma quebra de linha (ou o começo do arquivo) e só então junta tudo: uma
  // linha de MB (imagem em base64) não é copiada nem varrida de novo a cada bloco. Falhou, nada muda.
  const readUntilNewline = async (bounded: boolean): Promise<boolean> => {
    const parts: Buffer[] = []
    let at = pos
    while (at > 0) {
      if (bounded && scanned + (pos - at) >= SCAN_MAX && cursor < end) return false
      const length = Math.min(CHUNK_BYTES, at)
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await handle.read(chunk, 0, length, at - length)
      if (bytesRead !== length) return false
      at -= length
      parts.unshift(chunk)
      if (chunk.includes(NEWLINE)) break
    }
    scanned += pos - at
    pos = at
    pending = Buffer.concat([...parts, pending])
    return true
  }
  if (before === undefined) {
    await readUntilNewline(false)
    pending = pending.subarray(0, pending.lastIndexOf(NEWLINE) + 1)
  }
  end = pos + pending.length
  cursor = end
  const items: TranscriptItem[] = []
  // Resultado de ferramenta vai junto da chamada, que já conta: senão uma página de ferramentas não teria conversa.
  let counted = 0
  while (counted < limit && (pending.length > 0 || pos > 0)) {
    // Deslocamento negativo no lastIndexOf conta do fim: com uma linha vazia de 1 byte acharia a própria quebra.
    const previous = pending.length < 2 ? -1 : pending.lastIndexOf(NEWLINE, pending.length - 2)
    if (previous === -1 && pos > 0) {
      if (!(await readUntilNewline(true))) break
      continue
    }
    const lineFrom = previous + 1
    const parsed = parse(pending.subarray(lineFrom, pending.length - 1), pos + lineFrom)
    items.unshift(...parsed)
    counted += parsed.filter((item) => item.kind !== 'result').length
    pending = pending.subarray(0, lineFrom)
    cursor = pos + lineFrom
  }
  return { sessionId, items, start: cursor, end, atStart: cursor === 0 }
}

// O que entrou depois de `after`. Só linhas completas; com muito atraso, devolve até FORWARD_MAX e o celular
// pede de novo a partir do end.
async function pageAfter(handle: Handle, sessionId: string, after: number, parse: Parse): Promise<TranscriptPage> {
  const { size } = await handle.stat()
  if (!(await lineStart(handle, after, size))) return { ...empty(sessionId), reset: true }
  const length = Math.min(FORWARD_MAX, size - after)
  const data = Buffer.alloc(length)
  const { bytesRead } = await handle.read(data, 0, length, after)
  const last = data.subarray(0, bytesRead).lastIndexOf(NEWLINE)
  const items: TranscriptItem[] = []
  let from = 0
  while (from <= last) {
    const nl = data.indexOf(NEWLINE, from)
    items.push(...parse(data.subarray(from, nl), after + from))
    from = nl + 1
  }
  return { sessionId, items, start: after, end: after + last + 1, atStart: after === 0 }
}

// O turn_context mais recente antes de `until` (começo de linha), procurado de trás para frente sem interpretar as
// outras linhas.
async function turnContextBefore(handle: Handle, until: number): Promise<Entry | null> {
  let pos = until
  let data = Buffer.alloc(0)
  while (pos > 0 && until - pos < STATUS_SCAN_MAX) {
    const length = Math.min(CHUNK_BYTES, pos)
    const chunk = Buffer.alloc(length)
    const { bytesRead } = await handle.read(chunk, 0, length, pos - length)
    if (bytesRead !== length) return null
    pos -= length
    data = Buffer.concat([chunk, data])
    for (let at = data.lastIndexOf(TURN_CONTEXT); at !== -1; at = at === 0 ? -1 : data.lastIndexOf(TURN_CONTEXT, at - 1)) {
      const from = data.lastIndexOf(NEWLINE, at) + 1
      // O começo da linha ainda está no bloco anterior: lê mais e procura de novo.
      if (from === 0 && pos > 0) break
      const to = data.indexOf(NEWLINE, at)
      const entry = parseEntry(data.subarray(from, to === -1 ? data.length : to))
      if (entry?.['type'] === 'turn_context') return entry
    }
  }
  return null
}

function statusOf(context: Entry): TranscriptStatus {
  const p = (context['payload'] ?? {}) as Entry
  const status: TranscriptStatus = {}
  if (str(p['model'])) status.model = str(p['model'])
  if (str(p['effort'])) status.effort = str(p['effort'])
  const collaboration = str((p['collaboration_mode'] as Entry | undefined)?.['mode'])
  const approval = p['approval_policy']
  // A política granular é um objeto com as regras: o nome dela basta para a barra.
  const approvalName = typeof approval === 'string' ? approval : approval && typeof approval === 'object' ? Object.keys(approval)[0] ?? '' : ''
  const sandbox = str((p['sandbox_policy'] as Entry | undefined)?.['type'])
  const mode = [collaboration === 'default' ? '' : collaboration, approvalName, sandbox].filter(Boolean).join(' · ')
  if (mode) status.mode = mode
  return status
}

// Os ids dos itens são a posição da linha no arquivo: estáveis entre páginas e nas duas direções, e o rollout só
// cresce no fim (reescrito, o cursor deixa de cair em começo de linha e a leitura recomeça).
export async function codexTranscriptPage(file: string | null, threadId: string, cursor: TranscriptCursor): Promise<TranscriptPage> {
  const handle = file ? await openRollout(file) : null
  if (!handle) return cursor.after ? { ...empty(threadId), reset: true } : empty(threadId)
  try {
    const seen: { context: Entry | null } = { context: null }
    const forward = cursor.after !== undefined
    const parse: Parse = (line, offset) => {
      const entry = parseEntry(line)
      if (!entry) return []
      // De trás para frente o primeiro achado é o mais recente; para frente, o último.
      if (entry['type'] === 'turn_context' && (forward || seen.context === null)) seen.context = entry
      return codexItems(entry, String(offset))
    }
    if (cursor.after !== undefined) {
      const page = await pageAfter(handle, threadId, cursor.after, parse)
      if (seen.context) page.status = statusOf(seen.context)
      return page
    }
    const page = await pageBefore(handle, threadId, cursor.before, cursor.limit, parse)
    // Página antiga não diz nada sobre o agora; a do fim procura o turn_context em vigor se o turno não coube nela.
    if (cursor.before === undefined && !page.reset) {
      const context = seen.context ?? await turnContextBefore(handle, page.start)
      if (context) page.status = statusOf(context)
    }
    return page
  } finally {
    await handle.close()
  }
}
