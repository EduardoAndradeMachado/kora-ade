import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeOpencodeDb,
  deleteOpencodeSession,
  listOpencodeSessions,
  newOpencodeSessionId,
  opencodeActivity,
  opencodeDbPath
} from '../src/main/opencode'

// Mesmo formato do OpenCode 2.1.1: session_v2/session_message para as conversas novas e
// session/message como fallback das antigas. Só as colunas que o Kora lê.
function makeDb(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'kora-opencode-')), 'opencode.db')
  const db = new DatabaseSync(file)
  db.exec(`
    create table session_v2 (
      id text primary key,
      title text,
      time_updated integer not null,
      directory text not null,
      parent_id text,
      time_archived integer
    );
    create table session (
      id text primary key,
      title text,
      time_updated integer not null,
      directory text not null,
      parent_id text,
      time_archived integer
    );
    create table session_message (
      id text primary key,
      session_id text not null,
      type text not null,
      seq integer not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
    create table message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
  `)
  db.close()
  return file
}

function writeDb(file: string, sql: string, params: (string | number | null)[] = []): void {
  const db = new DatabaseSync(file)
  db.prepare(sql).run(...params)
  db.close()
}

const project = join(tmpdir(), 'kora-opencode-projeto')

function session(
  file: string,
  id: string,
  title: string,
  updatedAt: number,
  extra: { directory?: string; parent?: string | null; archived?: number | null; legacy?: boolean } = {}
): void {
  const table = extra.legacy ? 'session' : 'session_v2'
  writeDb(
    file,
    `insert into ${table} (id, title, time_updated, directory, parent_id, time_archived) values (?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      updatedAt,
      extra.directory ?? project.replace(/\\/g, '/'),
      extra.parent ?? null,
      extra.archived ?? null
    ]
  )
}

function message(file: string, sessionId: string, type: string, data: object, seq = 1, legacy = false): void {
  if (legacy) {
    writeDb(
      file,
      'insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)',
      [`msg_${sessionId}_${seq}`, sessionId, seq, seq, JSON.stringify(data)]
    )
    return
  }
  writeDb(
    file,
    'insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)',
    [`msg_${sessionId}_${seq}`, sessionId, type, seq, seq, seq, JSON.stringify(data)]
  )
}

afterEach(() => closeOpencodeDb())

describe('caminho do banco do OpenCode', () => {
  it('segue o padrão do OpenCode e respeita XDG_DATA_HOME e OPENCODE_DB', () => {
    const home = 'C:\\Users\\voce'
    expect(opencodeDbPath({}, home)).toBe(join(home, '.local', 'share', 'opencode', 'opencode.db'))
    expect(opencodeDbPath({ XDG_DATA_HOME: 'D:\\dados' }, home)).toBe(join('D:\\dados', 'opencode', 'opencode.db'))
    expect(opencodeDbPath({ OPENCODE_DB: 'C:\\temp\\oc.db' }, home)).toBe('C:\\temp\\oc.db')
    expect(opencodeDbPath({ OPENCODE_DB: 'beta.db' }, home)).toBe(
      join(home, '.local', 'share', 'opencode', 'beta.db')
    )
    expect(opencodeDbPath({ OPENCODE_DB: ':memory:' }, home)).toBe('')
  })

  it('gera IDs no formato aceito pela CLI', () => {
    const id = newOpencodeSessionId()
    expect(id).toMatch(/^ses_[0-9a-f]{32}$/)
    expect(newOpencodeSessionId()).not.toBe(id)
  })
})

describe('conversas do OpenCode', () => {
  it('lista as conversas da pasta, sem subagentes nem arquivadas, das duas gerações de tabela', async () => {
    const file = makeDb()
    session(file, 'ses_nova', 'Conversa nova', 3000)
    session(file, 'ses_antiga', 'Conversa antiga', 1000, { legacy: true })
    session(file, 'ses_sub', 'Subagente', 4000, { parent: 'ses_nova' })
    session(file, 'ses_arquivada', 'Arquivada', 5000, { archived: 1 })
    session(file, 'ses_outra_pasta', 'Outro projeto', 6000, { directory: 'C:/outro/projeto' })
    // A mesma conversa migrada aparece nas duas tabelas: vale uma vez só, com o título mais novo.
    session(file, 'ses_nova', 'Conversa nova (migrada)', 3500, { legacy: true })

    const list = await listOpencodeSessions(file, project)
    expect(list.map((s) => [s.sessionId, s.title, s.updatedAt])).toEqual([
      ['ses_nova', 'Conversa nova (migrada)', 3500],
      ['ses_antiga', 'Conversa antiga', 1000]
    ])
    expect(list.every((s) => s.kind === 'opencode')).toBe(true)
  })

  it('compara a pasta sem diferenciar barras, maiúsculas ou barra final', async () => {
    const file = makeDb()
    session(file, 'ses_um', 'Conversa', 1000, { directory: `${resolve(project).replace(/\\/g, '/')}/` })
    expect((await listOpencodeSessions(file, project)).map((s) => s.sessionId)).toEqual(['ses_um'])
  })

  it('banco inexistente ou vazio devolve lista vazia', async () => {
    expect(await listOpencodeSessions(join(tmpdir(), 'kora-nao-existe', 'opencode.db'), project)).toEqual([])
    const file = makeDb()
    expect(await listOpencodeSessions(file, project)).toEqual([])
  })
})

describe('estado do turno do OpenCode', () => {
  it('no v2 o turno só termina no idle; passo completed entre ferramentas continua trabalhando', () => {
    const file = makeDb()
    message(file, 'ses_teste', 'assistant', { time: { created: 1 } }, 1)
    expect(opencodeActivity(file, 'ses_teste')).toBe('working')
    // Cada passo do assistente termina com completed, mas o turno segue para a próxima ferramenta.
    message(file, 'ses_teste', 'assistant', { time: { created: 1, completed: 2 }, finish: 'tool-calls' }, 2)
    expect(opencodeActivity(file, 'ses_teste')).toBe('working')
    message(file, 'ses_teste', 'idle', {}, 3)
    expect(opencodeActivity(file, 'ses_teste')).toBe('waiting')
    message(file, 'ses_teste', 'user', {}, 4)
    expect(opencodeActivity(file, 'ses_teste')).toBe('working')
  })

  it('conversa v1 pelo papel da mensagem e conversa sem mensagem', () => {
    const file = makeDb()
    expect(opencodeActivity(file, 'ses_vazia')).toBeNull()
    message(file, 'ses_v1', 'assistant', { role: 'assistant', time: { completed: 9 } }, 1, true)
    expect(opencodeActivity(file, 'ses_v1')).toBe('waiting')
    message(file, 'ses_v1', 'user', { role: 'user' }, 2, true)
    expect(opencodeActivity(file, 'ses_v1')).toBe('working')
  })

  it('banco ausente é "sem leitura agora", não "sem estado"', () => {
    expect(opencodeActivity(join(tmpdir(), 'kora-nao-existe', 'opencode.db'), 'ses_teste')).toBeUndefined()
  })
})

describe('apagar conversa do OpenCode', () => {
  it('recusa ID fora do formato antes de chamar a CLI', async () => {
    await expect(deleteOpencodeSession('ses_x; Remove-Item C:\\', project)).rejects.toThrow(/inválido/)
  })
})
