import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { OPENCODE_SESSION_ID, type AgentActivity } from '../shared/agent'
import type { SessionSummary } from '../shared/ipc'

const TITLE_MAX = 90
const DELETE_TIMEOUT_MS = 60_000

// O OpenCode v2 guarda as conversas num SQLite em ~/.local/share/opencode/opencode.db.
// O caminho respeita as mesmas variáveis que a CLI (XDG_DATA_HOME e OPENCODE_DB).
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env['XDG_DATA_HOME']
  return join(xdg && xdg.trim() ? xdg : join(home, '.local', 'share'), 'opencode')
}

export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const custom = env['OPENCODE_DB']?.trim()
  if (custom === ':memory:') return ''
  if (custom) return isAbsolute(custom) ? custom : join(opencodeDataDir(env, home), custom)
  return join(opencodeDataDir(env, home), 'opencode.db')
}

export function newOpencodeSessionId(): string {
  return `ses_${randomUUID().replace(/-/g, '')}`
}

interface SessionRow {
  id: string
  title: string | null
  time_updated: number
  directory: string
  parent_id?: string | null
  time_archived?: number | null
}

interface MessageRow {
  type?: string
  data: string
}

// Conexão reaproveitada: a atividade é consultada a cada mudança do banco enquanto o agente trabalha.
// Se o OpenCode recriar ou migrar o arquivo, a próxima consulta reabre.
let connection: { file: string; db: DatabaseSync } | null = null
const sessionCache = new Map<string, SessionSummary[]>()

function closeConnection(): void {
  try {
    connection?.db.close()
  } catch {
    // A conexão já pode ter sido fechada pelo próprio SQLite (arquivo removido, por exemplo).
  }
  connection = null
}

export function closeOpencodeDb(): void {
  closeConnection()
  sessionCache.clear()
}

function connect(file: string): DatabaseSync | null {
  if (!file || !existsSync(file)) return null
  if (connection?.file === file) return connection.db
  closeConnection()
  try {
    connection = { file, db: new DatabaseSync(file, { readOnly: true }) }
    return connection.db
  } catch {
    return null
  }
}

function rows<T>(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): T[] | null {
  try {
    return db.prepare(sql).all(...params) as unknown as T[]
  } catch {
    return null
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const found = rows<{ name: string }>(db, "select name from sqlite_master where type = 'table' and name = ?", [name])
  return (found ?? []).some((row) => row.name === name)
}

// Consulta só-leitura pela mesma conexão. null = sem banco, tabela ausente ou leitura falhou agora.
export function queryOpencode<T>(dbFile: string, table: string, sql: string, params: SQLInputValue[] = []): T[] | null {
  const db = connect(dbFile)
  if (!db || !hasTable(db, table)) return null
  return rows<T>(db, sql, params)
}

const normalize = (path: string): string => resolve(path).replace(/[\\/]+$/, '').toLowerCase()

const clip = (text: string): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine
}

function sessionRows(db: DatabaseSync, table: string): SessionRow[] | null {
  if (!hasTable(db, table)) return []
  const full = rows<SessionRow>(
    db,
    `select id, title, time_updated, directory, parent_id, time_archived from ${table}`
  )
  if (full) return full
  // Esquema antigo sem parent_id/time_archived: ainda dá para listar as conversas.
  return rows<SessionRow>(db, `select id, title, time_updated, directory from ${table}`)
}

export async function listOpencodeSessions(dbFile: string, projectPath: string): Promise<SessionSummary[]> {
  const cacheKey = `${dbFile}\0${normalize(projectPath)}`
  const db = connect(dbFile)
  if (!db) {
    sessionCache.delete(cacheKey)
    return []
  }

  const v2 = sessionRows(db, 'session_v2')
  const v1 = sessionRows(db, 'session')
  // Sem leitura (banco travado no meio de uma migração): mantém a última lista boa em vez de esvaziar o painel.
  if (v2 === null && v1 === null) {
    closeConnection()
    return sessionCache.get(cacheKey) ?? []
  }

  const target = normalize(projectPath)
  const byId = new Map<string, { title: string; updatedAt: number }>()
  for (const row of [...(v2 ?? []), ...(v1 ?? [])]) {
    if (typeof row.id !== 'string' || !OPENCODE_SESSION_ID.test(row.id)) continue
    if (typeof row.directory !== 'string' || normalize(row.directory) !== target) continue
    if (typeof row.parent_id === 'string' && row.parent_id) continue
    if (typeof row.time_archived === 'number' && row.time_archived > 0) continue
    if (typeof row.time_updated !== 'number') continue
    const title = typeof row.title === 'string' ? clip(row.title) : ''
    const previous = byId.get(row.id)
    byId.set(row.id, {
      title: title || previous?.title || '',
      updatedAt: Math.max(row.time_updated, previous?.updatedAt ?? 0)
    })
  }

  const sessions: SessionSummary[] = [...byId]
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .map(([sessionId, { title, updatedAt }]) => ({
      kind: 'opencode',
      sessionId,
      title: title || 'Sem título',
      updatedAt
    }))
  sessionCache.set(cacheKey, sessions)
  return sessions
}

function activityOf(type: string, data: Record<string, unknown>, legacy = false): AgentActivity | null {
  if (type === 'idle') return 'waiting'
  if (legacy) {
    // Formato v1: o papel vem da mensagem e o fim do turno é o completed.
    if (type === 'assistant') {
      const time = data['time'] as { completed?: unknown } | undefined
      return typeof time?.completed === 'number' ? 'waiting' : 'working'
    }
    return type === 'user' ? 'working' : null
  }
  // No v2 a mensagem do assistente é gravada a cada passo e já vem completed entre duas ferramentas.
  // Quem marca o fim do turno é a mensagem "idle"; até ela chegar, o turno está em andamento.
  if (type === 'assistant' || type === 'user' || type === 'shell' || type === 'compaction' || type === 'synthetic') {
    return 'working'
  }
  return null
}

// undefined = não deu para ler agora (mantém o estado que a aba já mostrava); null = sem estado conhecido.
export function opencodeActivity(dbFile: string, sessionId: string): AgentActivity | null | undefined {
  if (!OPENCODE_SESSION_ID.test(sessionId)) return null
  const db = connect(dbFile)
  if (!db) return undefined

  if (hasTable(db, 'session_message')) {
    const latest = rows<MessageRow>(
      db,
      'select type, data from session_message where session_id = ? order by seq desc limit 1',
      [sessionId]
    )
    if (latest === null) return undefined
    if (latest.length > 0) {
      const row = latest[0]!
      try {
        return activityOf(row.type ?? '', JSON.parse(row.data) as Record<string, unknown>)
      } catch {
        return undefined
      }
    }
  }

  // Conversas anteriores ao formato v2: a tabela message guarda o papel dentro do JSON.
  if (!hasTable(db, 'message')) return null
  const legacy = rows<MessageRow>(
    db,
    'select data from message where session_id = ? order by time_created desc limit 1',
    [sessionId]
  )
  if (legacy === null) return undefined
  if (legacy.length === 0) return null
  try {
    const data = JSON.parse(legacy[0]!.data) as Record<string, unknown>
    const role = typeof data['role'] === 'string' ? data['role'] : ''
    return activityOf(role, data, true)
  } catch {
    return undefined
  }
}

// O delete da CLI é o caminho oficial: apaga também as mensagens e os dados ligados à conversa.
// A conversa do OpenCode não vai para a Lixeira do Windows; o texto da confirmação diz isso.
export async function deleteOpencodeSession(sessionId: string, cwd: string): Promise<void> {
  if (!OPENCODE_SESSION_ID.test(sessionId)) throw new Error(`ID de sessão inválido: ${JSON.stringify(sessionId)}`)
  await new Promise<void>((done, fail) => {
    // PowerShell, como nas abas: o cmd do Windows para no shim sem extensão que o pnpm cria
    // (opencode) e não chega ao opencode.CMD, enquanto o PowerShell resolve os dois.
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `opencode session delete ${sessionId} --standalone`],
      {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-4000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('O OpenCode demorou demais para apagar a conversa.'))
    }, DELETE_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      fail(new Error(`Não foi possível executar o OpenCode: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        sessionCache.clear()
        done()
        return
      }
      const message = output.replace(/\s+/g, ' ').trim()
      fail(new Error(message || `O OpenCode saiu com código ${code} ao apagar a conversa.`))
    })
  })
}
