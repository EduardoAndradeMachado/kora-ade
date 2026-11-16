import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  agyActivity,
  listAntigravitySessions,
  parseAgyConversationMeta,
  readAgyConversation,
  type AgyStep
} from '../src/main/antigravity-conversations'
import { listProjectSessions } from '../src/main/sessions'

// Bytes reais do agy 1.5.9 (ver "origem" no arquivo): metadados de uma conversa principal e de um subagente, e duas
// respostas do modelo, uma que pediu ferramenta (run_command) e a final ("ok").
const fixture = JSON.parse(readFileSync(new URL('./fixtures/agy-conversa.json', import.meta.url), 'utf8')) as {
  metaPrincipal: string
  metaSubagente: string
  respostaComFerramenta: { type: number; status: number; payload: string }
  respostaFinal: { type: number; status: number; payload: string }
}
const b64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'))
const META_MAIN = b64(fixture.metaPrincipal)
const META_SUB = b64(fixture.metaSubagente)
const step = (s: { type: number; status: number; payload: string }): AgyStep => ({ type: s.type, status: s.status, payload: b64(s.payload) })
const TOOL_RESPONSE = step(fixture.respostaComFerramenta)
const FINAL_RESPONSE = step(fixture.respostaFinal)
const PROJECT = 'C:\\Projetos\\exemplo'

// Tipos de passo vistos no agy 1.5.9: 14 pedido do usuário, 15 resposta do modelo, 132 ferramenta, 101 notificação.
const userInput: AgyStep = { type: 14, status: 3, payload: null }
const tool = (status: number): AgyStep => ({ type: 132, status, payload: null })

describe('metadados da conversa do agy', () => {
  it('lê a pasta da conversa principal e não acha conversa-mãe', () => {
    expect(parseAgyConversationMeta(META_MAIN)).toEqual({ workspace: 'file:///C:/Projetos/exemplo', parentId: null })
  })

  it('a conversa de subagente aponta para a conversa que o lançou', () => {
    expect(parseAgyConversationMeta(META_SUB)).toEqual({
      workspace: 'file:///C:/Projetos/exemplo',
      parentId: '701c908d-4e09-4135-b507-8a69ff2159d6'
    })
  })

  it('bytes que não são protobuf lançam em vez de virar metadado vazio', () => {
    expect(() => parseAgyConversationMeta(new Uint8Array([0x0a, 0x50, 0x01]))).toThrow()
  })
})

describe('atividade do agy pelos passos', () => {
  it('turno terminado na resposta final sem ferramenta: esperando você', () => {
    expect(agyActivity([userInput, TOOL_RESPONSE, tool(3), FINAL_RESPONSE])).toBe('waiting')
  })

  it('resposta que pediu ferramenta, ferramenta concluída ou pedido recém-enviado: trabalhando', () => {
    expect(agyActivity([userInput])).toBe('working')
    expect(agyActivity([userInput, TOOL_RESPONSE])).toBe('working')
    expect(agyActivity([userInput, TOOL_RESPONSE, tool(3)])).toBe('working')
  })

  it('comando em segundo plano ainda rodando segura o turno mesmo depois de uma resposta sem ferramenta', () => {
    expect(agyActivity([userInput, TOOL_RESPONSE, tool(2), FINAL_RESPONSE])).toBe('working')
  })

  it('aprovação pendente é esperando você; cancelado, erro ou interrompido encerram o turno', () => {
    expect(agyActivity([userInput, TOOL_RESPONSE, tool(9)])).toBe('waiting')
    for (const status of [6, 7, 12]) expect(agyActivity([userInput, TOOL_RESPONSE, tool(status)])).toBe('waiting')
  })

  it('conversa sem passos: esperando o primeiro pedido', () => {
    expect(agyActivity([])).toBe('waiting')
  })
})

// Pasta do agy de mentira com o mesmo esquema das tabelas usadas (agy 1.5.9).
function agyFolder(): { root: string; conversation(opts: { meta: Uint8Array; steps?: AgyStep[]; mtime?: Date }): string } {
  const root = mkdtempSync(join(tmpdir(), 'kora-agy-'))
  mkdirSync(join(root, 'conversations'))
  mkdirSync(join(root, 'cache'))
  return {
    root,
    conversation({ meta, steps = [], mtime }) {
      const id = randomUUID()
      const file = join(root, 'conversations', `${id}.db`)
      const db = new DatabaseSync(file)
      // Os bancos do agy ficam em modo WAL; é nele que abrir sem cuidado cria -wal e -shm.
      db.exec('pragma journal_mode = wal')
      db.exec('create table trajectory_metadata_blob (id text, data blob)')
      db.exec('create table steps (idx integer, step_type integer, status integer, step_payload blob)')
      db.prepare('insert into trajectory_metadata_blob values (?, ?)').run('meta', meta)
      steps.forEach((s, i) => db.prepare('insert into steps values (?, ?, ?, ?)').run(i, s.type, s.status, s.payload))
      db.close()
      if (mtime) utimesSync(file, mtime, mtime)
      return id
    }
  }
}

// O blob real com a pasta trocada: regravar o campo 7 muda o tamanho, então monta de novo só os campos usados.
function metaFor(workspace: string, parentId: string | null): Uint8Array {
  const field = (n: number, value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([Buffer.from([(n << 3) | 2, bytes.length]), bytes])
  }
  return new Uint8Array(Buffer.concat([field(7, workspace), ...(parentId ? [field(5, parentId)] : [])]))
}

const projectUri = pathToFileURL(PROJECT).href

describe('listagem das conversas do agy por projeto', () => {
  it('mostra as conversas do projeto com o título do índice ou do primeiro pedido, sem subagente, vazia, interna nem de outra pasta', async () => {
    const agy = agyFolder()
    const indexed = agy.conversation({ meta: META_MAIN, steps: [userInput, FINAL_RESPONSE], mtime: new Date('2026-11-10T10:00:00Z') })
    const open = agy.conversation({ meta: metaFor(projectUri, null), steps: [userInput] })
    const subagent = agy.conversation({ meta: META_SUB, steps: [userInput] })
    // Aberta e fechada sem nenhum pedido: nada a retomar.
    agy.conversation({ meta: metaFor(projectUri, null) })
    const internal = agy.conversation({ meta: metaFor(projectUri, null), steps: [userInput] })
    const elsewhere = agy.conversation({ meta: metaFor('file:///C:/Outro', null), steps: [userInput] })
    writeFileSync(
      join(agy.root, 'cache', 'conversation_metadata.json'),
      JSON.stringify({
        conversations: {
          [indexed]: { summary: { ID: indexed, Title: 'Criação de brandbook', Preview: 'veja esse projeto', UpdatedAt: '2026-11-12T08:00:00Z' }, is_internal: false },
          [internal]: { summary: { Title: 'Conversa interna', UpdatedAt: '2026-11-12T08:00:00Z' }, is_internal: true },
          [elsewhere]: { summary: { Title: 'De outra pasta', UpdatedAt: '2026-11-12T08:00:00Z' }, is_internal: false }
        }
      })
    )
    writeFileSync(
      join(agy.root, 'history.jsonl'),
      [
        { display: '/settings', timestamp: 1, workspace: PROJECT, conversationId: open, type: 'slash_command' },
        { display: 'quero tentar escalar esse bug', timestamp: Date.parse('2026-11-16T09:00:00Z'), workspace: PROJECT, conversationId: open },
        { display: 'e agora?', timestamp: Date.parse('2026-11-16T09:30:00Z'), workspace: PROJECT, conversationId: open },
        { display: 'pedido do subagente', timestamp: 5, workspace: PROJECT, conversationId: subagent }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')
    )

    const sessions = await listAntigravitySessions(agy.root, PROJECT)
    expect(sessions.sort((a, b) => a.title.localeCompare(b.title))).toEqual([
      { kind: 'antigravity', sessionId: indexed, title: 'Criação de brandbook', updatedAt: Date.parse('2026-11-12T08:00:00Z') },
      expect.objectContaining({ kind: 'antigravity', sessionId: open, title: 'quero tentar escalar esse bug' })
    ])
    expect(sessions.find((s) => s.sessionId === open)!.updatedAt).toBeGreaterThanOrEqual(Date.parse('2026-11-16T09:30:00Z'))
  })

  it('ler conversas fechadas não deixa -wal nem -shm na pasta do agy', async () => {
    const agy = agyFolder()
    const id = agy.conversation({ meta: META_MAIN, steps: [userInput, FINAL_RESPONSE] })
    await listAntigravitySessions(agy.root, PROJECT)
    readAgyConversation(agy.root, id)
    expect(readdirSync(join(agy.root, 'conversations'))).toEqual([`${id}.db`])
  })

  it('a aba Sessões recebe as conversas do agy junto com as dos outros agentes', async () => {
    const agy = agyFolder()
    const id = agy.conversation({ meta: META_MAIN, steps: [userInput, FINAL_RESPONSE], mtime: new Date('2026-11-01T00:00:00Z') })
    writeFileSync(
      join(agy.root, 'cache', 'conversation_metadata.json'),
      JSON.stringify({ conversations: { [id]: { summary: { Title: 'Triagem', UpdatedAt: '2026-11-12T08:00:00Z' } } } })
    )
    const empty = (): string => mkdtempSync(join(tmpdir(), 'kora-vazio-'))
    expect(await listProjectSessions(empty(), empty(), PROJECT, '', agy.root)).toEqual([
      { kind: 'antigravity', sessionId: id, title: 'Triagem', updatedAt: Date.parse('2026-11-12T08:00:00Z') }
    ])
  })

  it('sem a pasta do agy: lista vazia', async () => {
    expect(await listAntigravitySessions(join(tmpdir(), 'kora-sem-agy', randomUUID()), PROJECT)).toEqual([])
  })
})

describe('estado de uma conversa do agy', () => {
  it('marca subagente e lê a atividade dos passos do fim', () => {
    const agy = agyFolder()
    const main = agy.conversation({ meta: META_MAIN, steps: [userInput, TOOL_RESPONSE, tool(2)] })
    const sub = agy.conversation({ meta: META_SUB, steps: [userInput, FINAL_RESPONSE] })
    expect(readAgyConversation(agy.root, main)).toEqual({ subagent: false, activity: 'working' })
    expect(readAgyConversation(agy.root, sub)).toEqual({ subagent: true, activity: 'waiting' })
    expect(readAgyConversation(agy.root, randomUUID())).toBeNull()
  })
})
