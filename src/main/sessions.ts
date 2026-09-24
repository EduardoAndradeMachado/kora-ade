import { existsSync } from 'node:fs'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SESSION_ID } from '../shared/agent'
import type { SessionSummary } from '../shared/ipc'

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
const TITLE_MAX = 90

// Leitura assíncrona: a listagem passa por centenas de arquivos do Codex, e no main isso congelaria
// a saída de todos os terminais enquanto roda.
async function readSlice(file: string, fromEnd: boolean, bytes: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, fromEnd ? size - length : 0)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // linha cortada pela janela de leitura (início ou fim do trecho)
    }
  }
  return out
}

const clip = (text: string): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

// Mesma regra do Claude Code para nomear a pasta do projeto: todo caractere não alfanumérico vira '-'.
export function claudeProjectDir(claudeRoot: string, projectPath: string): string {
  return join(claudeRoot, 'projects', resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-'))
}

function firstUserText(lines: Record<string, unknown>[]): string | null {
  for (const line of lines) {
    if (line['type'] !== 'user' || line['isSidechain'] === true) continue
    const content = (line['message'] as { content?: unknown } | undefined)?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((c) => (c as { type?: string; text?: string }).type === 'text' ? (c as { text: string }).text : '').join(' ')
          : ''
    // Mensagens de sistema injetadas (comandos, lembretes) começam com tags; não servem de título.
    const cleaned = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, ' ').replace(/<[^>]+>/g, ' ').trim()
    if (cleaned) return cleaned
  }
  return null
}

export async function listClaudeSessions(claudeRoot: string, projectPath: string): Promise<SessionSummary[]> {
  const dir = claudeProjectDir(claudeRoot, projectPath)
  if (!existsSync(dir)) return []
  const sessions: SessionSummary[] = []
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.slice(0, -6)
    if (!SESSION_ID.test(sessionId)) continue
    const file = join(dir, name)
    try {
      const tail = jsonLines(await readSlice(file, true, TAIL_BYTES))
      const custom = tail.findLast((l) => l['type'] === 'custom-title')?.['customTitle']
      const ai = tail.findLast((l) => l['type'] === 'ai-title')?.['aiTitle']
      const head = jsonLines(await readSlice(file, false, HEAD_BYTES))
      const firstUser = firstUserText(head)
      // Sessão aberta e fechada sem nenhuma mensagem não tem o que retomar.
      if (!firstUser && typeof custom !== 'string' && typeof ai !== 'string') continue
      const title = typeof custom === 'string' ? custom : typeof ai === 'string' ? ai : firstUser!
      sessions.push({ kind: 'claude', sessionId, title: clip(title), updatedAt: (await stat(file)).mtimeMs })
    } catch {
      // arquivo sendo escrito ou removido no meio da leitura
    }
  }
  return sessions
}

interface CodexMeta {
  id: string | null
  cwd: string | null
  subagent: boolean
}

// A primeira linha (session_meta, ~22 KB) não muda: lida e interpretada uma vez por arquivo.
const codexMetaCache = new Map<string, CodexMeta>()
const codexFirstUserCache = new Map<string, string>()

function codexFirstUser(lines: Record<string, unknown>[]): string | null {
  for (const line of lines) {
    const payload = line['payload'] as { type?: string; role?: string; content?: { type?: string; text?: string }[] }
    if (line['type'] !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') continue
    const text = (payload.content ?? []).map((c) => (c.type === 'input_text' ? (c.text ?? '') : '')).join(' ').trim()
    // O Codex injeta AGENTS.md e contexto de ambiente como mensagens de usuário antes do pedido real.
    if (!text || text.startsWith('#') || text.startsWith('<')) continue
    return text
  }
  return null
}

// Só a primeira linha: interpretar os ~256 KB de cada conversa para achar a pasta custava CPU no main
// (o JSON.parse trava igual, com leitura assíncrona ou não).
async function codexMeta(file: string): Promise<CodexMeta> {
  const cached = codexMetaCache.get(file)
  if (cached) return cached
  const head = await readSlice(file, false, 64 * 1024)
  const newline = head.indexOf('\n')
  const first = jsonLines(newline >= 0 ? head.slice(0, newline) : head)[0]
  const meta = first?.['type'] === 'session_meta' ? (first['payload'] as Record<string, unknown>) : null
  const source = meta?.['source']
  const result: CodexMeta = {
    id: typeof meta?.['id'] === 'string' ? meta['id'] : null,
    cwd: typeof meta?.['cwd'] === 'string' ? meta['cwd'] : null,
    subagent: typeof source === 'object' && source !== null && 'subagent' in source
  }
  codexMetaCache.set(file, result)
  return result
}

// Título de reserva: só para conversas do projeto que não estão no session_index.
async function codexFallbackTitle(file: string): Promise<string | null> {
  const cached = codexFirstUserCache.get(file)
  if (cached) return cached
  const found = codexFirstUser(jsonLines(await readSlice(file, false, 256 * 1024)))
  if (found) codexFirstUserCache.set(file, found)
  return found
}

async function codexIndex(codexRoot: string): Promise<Map<string, { name: string; updatedAt: number }>> {
  const index = new Map<string, { name: string; updatedAt: number }>()
  const file = join(codexRoot, 'session_index.jsonl')
  if (!existsSync(file)) return index
  for (const line of jsonLines(await readFile(file, 'utf8'))) {
    const id = line['id']
    const name = line['thread_name']
    if (typeof id !== 'string' || typeof name !== 'string') continue
    index.set(id, { name, updatedAt: Date.parse(String(line['updated_at'])) || 0 })
  }
  return index
}

async function* rolloutFiles(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* rolloutFiles(full)
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) yield full
  }
}

export async function listCodexSessions(codexRoot: string, projectPath: string): Promise<SessionSummary[]> {
  const index = await codexIndex(codexRoot)
  const sessions: SessionSummary[] = []
  for await (const file of rolloutFiles(join(codexRoot, 'sessions'))) {
    const sessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1]
    if (!sessionId) continue
    try {
      const meta = await codexMeta(file)
      // Subagentes são threads internas de outra conversa; retomá-las sozinhas não faz sentido.
      if (!meta.cwd || meta.subagent || !samePath(meta.cwd, projectPath)) continue
      const indexed = index.get(sessionId)
      const title = indexed?.name ?? (await codexFallbackTitle(file))
      if (!title) continue
      const mtime = (await stat(file)).mtimeMs
      sessions.push({
        kind: 'codex',
        sessionId,
        title: clip(title),
        updatedAt: Math.max(mtime, indexed?.updatedAt ?? 0)
      })
    } catch {
      // arquivo sendo escrito ou removido no meio da leitura
    }
  }
  return sessions
}

export async function listProjectSessions(
  claudeRoot: string,
  codexRoot: string,
  projectPath: string
): Promise<SessionSummary[]> {
  const [claude, codex] = await Promise.all([
    listClaudeSessions(claudeRoot, projectPath),
    listCodexSessions(codexRoot, projectPath)
  ])
  return [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt)
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

// Compara caminhos já resolvidos por realpath: um link simbólico ou junction que aponte para fora de
// `root` resolve para fora e é recusado.
async function confined(root: string, candidate: string): Promise<string | null> {
  const [rootReal, candidateReal] = await Promise.all([realpathOrNull(root), realpathOrNull(candidate)])
  if (!rootReal || !candidateReal) return null
  const rel = relative(rootReal, candidateReal)
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  return inside ? candidateReal : null
}

async function claudeArtifacts(claudeRoot: string, sessionId: string, projectPath: string): Promise<string[]> {
  const dir = await confined(claudeRoot, claudeProjectDir(claudeRoot, projectPath))
  if (!dir) return []
  const transcript = await confined(dir, join(dir, `${sessionId}.jsonl`))
  if (!transcript || !(await stat(transcript).catch(() => null))?.isFile()) return []
  // Pasta irmã com o mesmo id: subagentes e resultados de ferramenta da conversa.
  const extras = await confined(dir, join(dir, sessionId))
  if (!extras || !(await stat(extras).catch(() => null))?.isDirectory()) return [transcript]
  return [transcript, extras]
}

async function codexArtifacts(codexRoot: string, sessionId: string, projectPath: string): Promise<string[]> {
  const sessionsDir = join(codexRoot, 'sessions')
  const sessionsReal = await confined(codexRoot, sessionsDir)
  if (!sessionsReal) return []
  const found: string[] = []
  for await (const file of rolloutFiles(sessionsDir)) {
    try {
      const meta = await codexMeta(file)
      if (meta.id?.toLowerCase() !== sessionId.toLowerCase()) continue
      // Mesmos critérios da listagem: só apaga o que a aba Sessões mostra para este projeto.
      if (!meta.cwd || meta.subagent || !samePath(meta.cwd, projectPath)) continue
      const real = await confined(sessionsReal, file)
      if (real) found.push(real)
    } catch {
      // arquivo sendo escrito ou removido no meio da leitura
    }
  }
  return found
}

export async function sessionArtifacts(
  kind: 'claude' | 'codex',
  sessionId: string,
  projectPath: string,
  roots: { claudeRoot: string; codexRoot: string }
): Promise<string[]> {
  if (!SESSION_ID.test(sessionId)) throw new Error(`ID de sessão inválido: ${JSON.stringify(sessionId)}`)
  if (kind === 'claude') return claudeArtifacts(roots.claudeRoot, sessionId, projectPath)
  if (kind === 'codex') return codexArtifacts(roots.codexRoot, sessionId, projectPath)
  throw new Error(`Tipo de agente desconhecido: ${JSON.stringify(kind)}`)
}
