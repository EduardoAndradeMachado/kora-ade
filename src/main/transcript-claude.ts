import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptItem, TranscriptPage, TranscriptStatus } from '../shared/transcript'
import { claudeTranscript } from './metrics'
import { claudeProjectDir } from './sessions'

const TEXT_MAX = 16 * 1024
const RESULT_MAX = 1500
const SUMMARY_MAX = 200
const CHUNK_BYTES = 256 * 1024
// Uma página percorre no máximo isto: um trecho só de ruído (snapshots, lembretes) não prende o main lendo MB.
// A página volta com menos itens e o celular pede a próxima.
const SCAN_MAX = 8 * 1024 * 1024
const NEWLINE = 0x0a

type Entry = Record<string, unknown>
type Block = { type?: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

const clip = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false }

const oneLine = (text: string, max = SUMMARY_MAX): string => clip(text.replace(/\s+/g, ' ').trim(), max).text

const tag = (text: string, name: string): string | null => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null

// Lembretes e contexto que o Claude Code injeta na mensagem: são para o modelo, não fazem parte do que a pessoa escreveu.
const withoutInjected = (text: string): string =>
  text.replace(/<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/g, '').trim()

function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof i[key] === 'string' && i[key]) return i[key] as string
    return undefined
  }
  const chosen =
    name === 'Bash' || name === 'PowerShell' ? pick('description', 'command')
      : name === 'Grep' || name === 'Glob' ? pick('pattern')
        : pick('file_path', 'path', 'description', 'url', 'query', 'skill', 'prompt', 'command')
  return chosen ? oneLine(chosen) : ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map((b) => (b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[imagem]' : ''))
    .filter(Boolean)
    .join('\n')
}

// Texto do usuário que é, na verdade, um aviso do próprio Claude Code (tarefa em segundo plano, comando de barra,
// saída de comando): vira nota, não balão.
function userNote(text: string): string | null {
  if (text.startsWith('<task-notification>')) return tag(text, 'summary') ?? 'Tarefa em segundo plano terminou'
  const command = tag(text, 'command-name')
  if (command) return oneLine(`${command} ${tag(text, 'command-args') ?? ''}`)
  const stdout = tag(text, 'local-command-stdout') ?? tag(text, 'bash-stdout')
  if (stdout !== null) return stdout ? oneLine(stdout, 600) : null
  if (/^<(local-command-stderr|bash-stderr)>/.test(text)) return oneLine(tag(text, 'local-command-stderr') ?? tag(text, 'bash-stderr') ?? '', 600) || null
  return null
}

function userItems(base: string, at: string, content: unknown): TranscriptItem[] {
  const out: TranscriptItem[] = []
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : []
  const texts: string[] = []
  let images = 0
  blocks.forEach((b, index) => {
    if (b.type === 'tool_result' && b.tool_use_id) {
      const { text, truncated } = clip(resultText(b.content), RESULT_MAX)
      out.push({ kind: 'result', id: `${base}:${index}`, at, toolId: b.tool_use_id, text, error: b.is_error === true, truncated })
    } else if (b.type === 'image') images++
    else if (b.type === 'text' && b.text) texts.push(b.text)
  })
  const raw = texts.join('\n\n')
  const note = raw ? userNote(raw.trim()) : null
  if (note !== null) out.push({ kind: 'note', id: `${base}:note`, at, text: note })
  else if (raw.trim().startsWith('<task-notification>') || /^<(local-command-|bash-std)/.test(raw.trim())) {
    // Saída vazia de comando: nada a mostrar.
  } else {
    const bash = tag(raw, 'bash-input')
    const cleaned = bash !== null ? `! ${bash}` : withoutInjected(raw)
    if (cleaned || images) out.push({ kind: 'user', id: `${base}:user`, at, ...clip(cleaned, TEXT_MAX), images })
  }
  return out
}

// Uma linha do .jsonl do Claude Code vira zero ou mais itens. O formato não é documentado e muda entre versões:
// o que não for reconhecido é ignorado, nunca derruba a leitura.
export function claudeItems(entry: Entry): TranscriptItem[] {
  if (entry['isSidechain'] === true || entry['isMeta'] === true) return []
  const base = typeof entry['uuid'] === 'string' ? entry['uuid'] : ''
  if (!base) return []
  const at = typeof entry['timestamp'] === 'string' ? entry['timestamp'] : ''
  const type = entry['type']
  if (type === 'system') {
    if (entry['subtype'] === 'compact_boundary') return [{ kind: 'note', id: base, at, text: 'Conversa compactada' }]
    if (entry['subtype'] === 'turn_duration') return [{ kind: 'turn', id: base, at, durationMs: typeof entry['durationMs'] === 'number' ? entry['durationMs'] : null }]
    return []
  }
  if (type === 'attachment') {
    // Mensagem escrita enquanto o agente trabalhava: entra na conversa como anexo do turno, não como linha de usuário.
    const a = entry['attachment'] as { type?: string; prompt?: unknown; commandMode?: string } | undefined
    if (a?.type === 'queued_command' && a.commandMode === 'prompt' && typeof a.prompt === 'string') return userItems(base, at, a.prompt)
    return []
  }
  const message = entry['message'] as { content?: unknown } | undefined
  if (!message) return []
  if (type === 'user') {
    if (entry['isCompactSummary'] === true) return []
    return userItems(base, at, message.content)
  }
  if (type !== 'assistant' || !Array.isArray(message.content)) return []
  const out: TranscriptItem[] = []
  ;(message.content as Block[]).forEach((b, index) => {
    const id = `${base}:${index}`
    if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'assistant', id, at, ...clip(b.text, TEXT_MAX) })
    else if (b.type === 'tool_use' && b.name) out.push({ kind: 'tool', id, at, toolId: b.id ?? id, name: b.name, summary: toolSummary(b.name, b.input) })
  })
  return out
}

function parse(line: Buffer): TranscriptItem[] {
  if (line.length === 0) return []
  try {
    const entry = JSON.parse(line.toString('utf8')) as unknown
    return entry && typeof entry === 'object' ? claudeItems(entry as Entry) : []
  } catch {
    return []
  }
}

// Cursor que não cai num começo de linha não veio desta leitura (ou o arquivo foi reescrito por baixo).
async function lineStart(handle: Awaited<ReturnType<typeof open>>, offset: number, size: number): Promise<boolean> {
  if (offset === 0) return true
  if (offset > size) return false
  const byte = Buffer.alloc(1)
  await handle.read(byte, 0, 1, offset - 1)
  return byte[0] === NEWLINE
}

const empty = (sessionId: string): TranscriptPage => ({ sessionId, items: [], start: 0, end: 0, atStart: true })

// Página que termina em `before` (ou no fim do arquivo), lida de trás para frente até juntar `limit` itens.
// A última linha sem quebra está sendo escrita agora: fica de fora, e o end para antes dela.
export async function claudePageBefore(file: string, sessionId: string, before: number | undefined, limit: number): Promise<TranscriptPage> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(sessionId)
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (before !== undefined && !(await lineStart(handle, before, size))) return { ...empty(sessionId), reset: true }
    let pos = before ?? size
    // pending: bytes de pos até cursor, ainda não lidos como linha. cursor é sempre começo de linha.
    let pending = Buffer.alloc(0)
    let scanned = 0
    const readChunk = async (): Promise<boolean> => {
      const length = Math.min(CHUNK_BYTES, pos)
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await handle.read(chunk, 0, length, pos - length)
      if (bytesRead !== length) return false
      pos -= length
      scanned += length
      pending = Buffer.concat([chunk, pending])
      return true
    }
    if (before === undefined) {
      while (pending.indexOf(NEWLINE) === -1 && pos > 0) if (!(await readChunk())) break
      pending = pending.subarray(0, pending.lastIndexOf(NEWLINE) + 1)
    }
    const end = pos + pending.length
    let cursor = end
    const items: TranscriptItem[] = []
    // Resultado de ferramenta vai junto da chamada, que já conta: senão uma página de ferramentas não teria conversa.
    let counted = 0
    while (counted < limit && (pending.length > 0 || pos > 0)) {
      // Deslocamento negativo no lastIndexOf conta do fim: com uma linha vazia de 1 byte acharia a própria quebra.
      const previous = pending.length < 2 ? -1 : pending.lastIndexOf(NEWLINE, pending.length - 2)
      if (previous === -1 && pos > 0) {
        if (scanned >= SCAN_MAX && cursor < end) break
        if (!(await readChunk())) break
        continue
      }
      const lineFrom = previous + 1
      const parsed = parse(pending.subarray(lineFrom, pending.length - 1))
      items.unshift(...parsed)
      counted += parsed.filter((item) => item.kind !== 'result').length
      pending = pending.subarray(0, lineFrom)
      cursor = pos + lineFrom
    }
    const start = cursor
    return { sessionId, items, start, end, atStart: start === 0 }
  } finally {
    await handle.close()
  }
}

const FORWARD_MAX = 4 * 1024 * 1024

// O que entrou depois de `after`. Só linhas completas; com muito atraso, devolve até FORWARD_MAX e o celular
// pede de novo a partir do end.
export async function claudePageAfter(file: string, sessionId: string, after: number): Promise<TranscriptPage> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return after === 0 ? empty(sessionId) : { ...empty(sessionId), reset: true }
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (!(await lineStart(handle, after, size))) return { ...empty(sessionId), reset: true }
    let data = Buffer.alloc(Math.min(FORWARD_MAX, size - after))
    let filled = (await handle.read(data, 0, data.length, after)).bytesRead
    let last = data.subarray(0, filled).lastIndexOf(NEWLINE)
    // Uma linha só pode passar de FORWARD_MAX (imagem colada vai em base64): sem quebra na janela, lê até achar o fim
    // dela, senão o cursor nunca sairia do lugar.
    while (last === -1 && after + filled < size) {
      const more = Buffer.alloc(Math.min(FORWARD_MAX, size - after - filled))
      const { bytesRead } = await handle.read(more, 0, more.length, after + filled)
      if (bytesRead === 0) break
      const at = more.subarray(0, bytesRead).indexOf(NEWLINE)
      data = Buffer.concat([data.subarray(0, filled), more.subarray(0, bytesRead)])
      if (at !== -1) last = filled + at
      filled += bytesRead
    }
    const items: TranscriptItem[] = []
    let from = 0
    while (from <= last) {
      const nl = data.indexOf(NEWLINE, from)
      items.push(...parse(data.subarray(from, nl)))
      from = nl + 1
    }
    return { sessionId, items, start: after, end: after + last + 1, atStart: after === 0 }
  } finally {
    await handle.close()
  }
}

export interface TranscriptCursor { before?: number; after?: number; limit: number }

// Conversa nova ainda sem arquivo: o caminho onde ele vai nascer, e a leitura devolve página vazia.
export async function claudeTranscriptFile(claudeRoot: string, sessionId: string, projectPath: string): Promise<string> {
  return (await claudeTranscript(claudeRoot, projectPath, sessionId)) ?? join(claudeProjectDir(claudeRoot, projectPath), `${sessionId}.jsonl`)
}

export async function claudeTabTranscript(claudeRoot: string, sessionId: string, projectPath: string, cursor: TranscriptCursor): Promise<TranscriptPage> {
  const file = await claudeTranscriptFile(claudeRoot, sessionId, projectPath)
  return cursor.after !== undefined ? claudePageAfter(file, sessionId, cursor.after) : claudePageBefore(file, sessionId, cursor.before, cursor.limit)
}

async function readWindow(file: string, fromEnd: boolean, bytes: number): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, fromEnd ? size - length : 0)
    const lines = buffer.toString('utf8').split('\n')
    // As pontas do trecho podem ter cortado uma linha no meio.
    if (fromEnd && length < size) lines.shift()
    if (!fromEnd && length < size) lines.pop()
    return lines
  } finally {
    await handle.close()
  }
}

const STATUS_TAIL = 512 * 1024
// Na primeira página o celular ainda não sabe nada: vale procurar mais fundo, porque um turno longo grava MB de
// ferramentas depois da última linha de modo. Nas novidades o celular junta com o que já tinha.
export const STATUS_DEEP = 8 * 1024 * 1024

// Esforço e modo de permissão atuais. O Claude grava uma linha api-request a cada chamada (até ~10 KB) e o modo a cada
// turno: no fim do arquivo estão os valores em vigor. Modelo e contexto vêm das métricas, que já seguem o arquivo.
export async function claudeStatus(file: string, window = STATUS_TAIL): Promise<TranscriptStatus> {
  const status: TranscriptStatus = {}
  const lines = await readWindow(file, true, window)
  for (let i = lines.length - 1; i >= 0 && (status.effort === undefined || status.mode === undefined); i--) {
    const line = lines[i]!
    if (status.effort === undefined && line.startsWith('{"type":"api-request"')) {
      try {
        const entry = JSON.parse(line) as { querySource?: string; params?: { model?: unknown; output_config?: { effort?: unknown } } }
        // Subagentes e chamadas auxiliares (título, resumo) usam outros modelos: só a conversa principal vale.
        if (entry.querySource !== 'repl_main_thread') continue
        if (typeof entry.params?.output_config?.effort === 'string') status.effort = entry.params.output_config.effort
        if (typeof entry.params?.model === 'string') status.model ??= entry.params.model
      } catch { /* linha corrompida */ }
    } else if (status.mode === undefined && line.includes('"type":"permission-mode"')) {
      try {
        const mode = (JSON.parse(line) as { permissionMode?: unknown }).permissionMode
        if (typeof mode === 'string') status.mode = mode
      } catch { /* linha corrompida */ }
    }
  }
  return status
}

export interface SkillEntry { name: string; description: string }

// A lista de skills que o Claude Code anunciou ao modelo no começo da conversa (inclui as de plugins). Fica nos
// primeiros KB do arquivo, junto da primeira mensagem.
export async function claudeSkills(file: string): Promise<SkillEntry[]> {
  for (const line of await readWindow(file, false, 512 * 1024)) {
    if (!line.includes('"skill_listing"')) continue
    try {
      const content = (JSON.parse(line) as { attachment?: { type?: string; content?: unknown } }).attachment
      if (content?.type !== 'skill_listing' || typeof content.content !== 'string') continue
      return content.content.split('\n').flatMap((row) => {
        // Skill de plugin tem dois-pontos no nome (plugin:skill): o nome termina no ": " antes da descrição.
        const match = row.match(/^- (\S+?):(?: (.*))?$/)
        return match ? [{ name: match[1]!, description: oneLine(match[2] ?? '', 120) }] : []
      })
    } catch { /* linha corrompida */ }
  }
  return []
}
