import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { dayMetrics, sessionMetrics } from '../src/main/metrics'
import { agyDay, agyMetrics, tallyAgySteps, type AgyModelOf, type AgyStepRow } from '../src/main/metrics-antigravity'
import { isOff } from '../src/shared/metrics'

// Metadados reais de passos do agy 1.5.10 (ver "origem" no arquivo): uma resposta do Gemini 4 Carbon, a primeira
// resposta de uma conversa (sem o ponteiro 20.3 para o gen_metadata) e duas compactações, uma com o uso no campo 9
// e outra só no 28.2.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/agy-metricas.json', import.meta.url), 'utf8')) as Record<
  'resposta' | 'primeiraResposta' | 'compactacao' | 'compactacaoSo28',
  { type: number; status: number; metadata: string }
>
const conversation = JSON.parse(readFileSync(new URL('./fixtures/agy-conversa.json', import.meta.url), 'utf8')) as {
  metaPrincipal: string
  metaSubagente: string
}
const b64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'))
const real = (s: { type: number; status: number; metadata: string }): AgyStepRow => ({ ...s, metadata: b64(s.metadata) })
const RESPONSE = real(fixture.resposta)
const FIRST_RESPONSE = real(fixture.primeiraResposta)
const COMPACTION = real(fixture.compactacao)
const COMPACTION_28 = real(fixture.compactacaoSo28)
const userInput: AgyStepRow = { type: 14, status: 3, metadata: null }
const tool = (status: number): AgyStepRow => ({ type: 132, status, metadata: null })
const GENERATING = 8

// Horários gravados na resposta: pedido às 02:17:32.230 UTC e fim às 02:20:33.210 UTC de 2026-11-18.
const RESPONSE_AT = 1794968433210
const RESPONSE_MS = 180_980

function recording(name: string): { modelOf: AgyModelOf; calls: [number | null, number][] } {
  const calls: [number | null, number][] = []
  return { modelOf: (code, generation) => (calls.push([code, generation]), name), calls }
}

// Protobuf mínimo para casos que o agy grava raramente: chave = campo << 3 | tipo; 0 varint, 2 bytes.
const varint = (n: number): number[] => {
  const out: number[] = []
  do {
    out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0))
    n = Math.floor(n / 0x80)
  } while (n > 0)
  return out
}
const proto = (fields: [number, number | Uint8Array][]): Uint8Array =>
  new Uint8Array(
    fields.flatMap(([field, value]) =>
      typeof value === 'number' ? [...varint(field << 3), ...varint(value)] : [...varint((field << 3) | 2), ...varint(value.length), ...value]
    )
  )
const time = (ms: number): Uint8Array => proto([[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1e6]])

describe('passos do agy viram respostas', () => {
  it('lê horários, uso e modelo da resposta real', () => {
    const { modelOf, calls } = recording('gemini-4-carbon')
    const { responses } = tallyAgySteps([userInput, RESPONSE], modelOf)
    expect(calls).toEqual([[1437, 237]])
    expect(responses).toHaveLength(1)
    const r = responses[0]!
    expect(r).toMatchObject({
      at: RESPONSE_AT,
      model: 'gemini-4-carbon',
      inputTokens: 2090,
      cacheReadTokens: 311_339,
      cacheWriteTokens: 0,
      outputTokens: 8411,
      contextTokens: 313_429,
      durationMs: RESPONSE_MS
    })
    expect(r.tps).toBeCloseTo(8411 / (RESPONSE_MS / 1000), 6)
    // Carbon em novembro de 2026: US$ 2 de entrada, 0,10 de cache lido e 10 de saída por milhão.
    expect(r.costUsd).toBeCloseTo((2090 * 2 + 311_339 * 0.1 + 8411 * 10) / 1_000_000, 10)
  })

  it('a primeira resposta, sem ponteiro, procura o modelo na linha 0 do gen_metadata', () => {
    const { modelOf, calls } = recording('gemini-4-carbon')
    const { responses } = tallyAgySteps([userInput, FIRST_RESPONSE], modelOf)
    expect(calls).toEqual([[1437, 0]])
    expect(responses.map((r) => [r.inputTokens, r.outputTokens])).toEqual([[13_512, 468]])
  })

  it('compactação conta como resposta, com o uso do campo 9 ou, sem contagens nele, do 28.2', () => {
    const { modelOf, calls } = recording('gemini-4-carbon')
    const tally = tallyAgySteps([COMPACTION, COMPACTION_28], modelOf)
    expect(tally.compactions).toBe(2)
    expect(tally.responses.map((r) => [r.inputTokens, r.cacheReadTokens, r.outputTokens])).toEqual([
      [9801, 510_632, 6912],
      [6105, 134_214, 2738]
    ])
    // A compactação não grava o campo 11; o código vem do 9.1 quando ele existe.
    expect(calls.map(([code]) => code)).toEqual([1437, null])
  })

  it('resposta com saída zero ainda conta a entrada (protobuf não grava o campo zerado)', () => {
    const meta = proto([
      [1, time(RESPONSE_AT - 2000)],
      [7, time(RESPONSE_AT)],
      [9, proto([[2, 1000], [5, 2000]])]
    ])
    const { responses } = tallyAgySteps([{ type: 15, status: 3, metadata: meta }], recording('gemini-4-carbon').modelOf)
    expect(responses.map((r) => [r.inputTokens, r.cacheReadTokens, r.outputTokens, r.tps])).toEqual([[1000, 2000, 0, null]])
  })

  it('conta turnos pelos pedidos e no máximo uma interrupção por turno', () => {
    const steps = [userInput, RESPONSE, tool(6), tool(6), userInput, tool(12), userInput, tool(3)]
    const tally = tallyAgySteps(steps, recording('x').modelOf)
    expect(tally.turns).toBe(3)
    expect(tally.interruptions).toBe(2)
  })

  it('resposta ainda gerando ou com metadado ilegível fica fora da conta', () => {
    const generating = { ...RESPONSE, status: GENERATING }
    const garbage = { ...RESPONSE, metadata: new Uint8Array([0x0a, 0x50, 0x01]) }
    expect(tallyAgySteps([generating, garbage, RESPONSE], recording('x').modelOf).responses).toHaveLength(1)
  })
})

const SCHEMA = `
  CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
    has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob,
    task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
  CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id));
`
const GEN_SCHEMA = 'CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));'

// Só o nome do modelo (campo 1.19) da linha de gen_metadata; a linha real traz também o prompt inteiro.
const generationRow = (model: string): Uint8Array => proto([[1, proto([[19, new Uint8Array(Buffer.from(model, 'utf8'))]])]])

// Esquema das tabelas usadas, como o agy 1.5.10 cria. generations null: banco sem a tabela gen_metadata.
function writeConversation(file: string, meta: Uint8Array, steps: AgyStepRow[], generations: Map<number, string> | null): void {
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  db.prepare('insert into trajectory_metadata_blob (id, data) values (?, ?)').run('main', meta)
  steps.forEach((s, idx) => insertStep(db, idx, s))
  if (generations) {
    db.exec(GEN_SCHEMA)
    for (const [idx, model] of generations) db.prepare('insert into gen_metadata (idx, data) values (?, ?)').run(idx, generationRow(model))
  }
  db.close()
}

const insertStep = (db: DatabaseSync, idx: number, s: AgyStepRow): void => {
  db.prepare('insert into steps (idx, step_type, status, metadata) values (?, ?, ?, ?)').run(idx, s.type, s.status, s.metadata)
}

function edit(file: string, change: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file)
  change(db)
  db.close()
}

// metaSubagente aponta para esta conversa-mãe.
const MAIN_ID = '701c908d-4e09-4135-b507-8a69ff2159d6'

function agyFolder(): { root: string; mainFile: string; subFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'kora-agy-metricas-'))
  mkdirSync(join(root, 'conversations'))
  const mainFile = join(root, 'conversations', `${MAIN_ID}.db`)
  const subFile = join(root, 'conversations', `${randomUUID()}.db`)
  const carbon = new Map([[237, 'gemini-4-carbon']])
  writeConversation(mainFile, b64(conversation.metaPrincipal), [userInput, RESPONSE, tool(3)], carbon)
  writeConversation(subFile, b64(conversation.metaSubagente), [RESPONSE], carbon)
  return { root, mainFile, subFile }
}

function emptyFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'kora-agy-metricas-'))
  mkdirSync(join(root, 'conversations'))
  return root
}

describe('métricas da conversa do agy pelo banco', () => {
  it('lê a conversa, o nome do modelo no gen_metadata e os subagentes', () => {
    const { root } = agyFolder()
    const m = agyMetrics(root, MAIN_ID)
    expect(m).toMatchObject({ agent: 'antigravity', sessionId: MAIN_ID, turns: 1, subagents: 1, compactions: 0, costKind: 'estimado' })
    expect(m.responses.map((r) => r.model)).toEqual(['gemini-4-carbon'])
    expect(typeof m.responses[0]!.costUsd).toBe('number')
    expect(m.subagentResponses).toHaveLength(1)
    expect(isOff(m.contextWindow)).toBe(true)
  })

  it('conversa de uma resposta só já mostra modelo e preço na primeira leitura', () => {
    const root = emptyFolder()
    const id = randomUUID()
    writeConversation(join(root, 'conversations', `${id}.db`), b64(conversation.metaPrincipal), [userInput, FIRST_RESPONSE], new Map([[0, 'claude-opus-4-6-thinking']]))
    const [r] = agyMetrics(root, id).responses
    expect(r!.model).toBe('claude-opus-4-6-thinking')
    expect(typeof r!.costUsd).toBe('number')
  })

  it('o mesmo código de modelo pode ter nomes diferentes em conversas diferentes', () => {
    const root = emptyFolder()
    const [a, b] = [randomUUID(), randomUUID()]
    writeConversation(join(root, 'conversations', `${a}.db`), b64(conversation.metaPrincipal), [RESPONSE], new Map([[237, 'gemini-flash-safety-le2']]))
    writeConversation(join(root, 'conversations', `${b}.db`), b64(conversation.metaPrincipal), [RESPONSE], new Map([[237, 'gemini-3.7-flash']]))
    expect(agyMetrics(root, a).responses[0]!.model).toBe('gemini-flash-safety-le2')
    expect(agyMetrics(root, b).responses[0]!.model).toBe('gemini-3.7-flash')
  })

  it('sem a tabela gen_metadata, a conversa conta igual e o modelo fica desconhecido', () => {
    const root = emptyFolder()
    const id = randomUUID()
    writeConversation(join(root, 'conversations', `${id}.db`), b64(conversation.metaPrincipal), [userInput, RESPONSE], null)
    const m = agyMetrics(root, id)
    expect(m.turns).toBe(1)
    expect(m.responses.map((r) => [r.model, r.outputTokens, isOff(r.costUsd)])).toEqual([['desconhecido', 8411, true]])
  })

  it('acompanha a conversa: passo novo entra e resposta que terminou de gerar passa a contar', () => {
    const { root, mainFile } = agyFolder()
    expect(agyMetrics(root, MAIN_ID).responses).toHaveLength(1)
    edit(mainFile, (db) => {
      insertStep(db, 3, userInput)
      insertStep(db, 4, { ...RESPONSE, status: GENERATING })
    })
    expect(agyMetrics(root, MAIN_ID)).toMatchObject({ turns: 2, responses: [{}] })
    edit(mainFile, (db) => db.prepare('update steps set status = 3 where idx = 4').run())
    expect(agyMetrics(root, MAIN_ID).responses).toHaveLength(2)
  })

  it('conversa aberta pelo agy (WAL): passo que só está no -wal também entra', () => {
    const root = emptyFolder()
    const id = randomUUID()
    const file = join(root, 'conversations', `${id}.db`)
    writeConversation(file, b64(conversation.metaPrincipal), [userInput, RESPONSE], new Map([[237, 'gemini-4-carbon']]))
    const agy = new DatabaseSync(file)
    try {
      agy.exec('PRAGMA journal_mode=WAL')
      insertStep(agy, 2, userInput)
      expect(agyMetrics(root, id).turns).toBe(2)
      const db = statSync(file)
      insertStep(agy, 3, userInput)
      expect(statSync(file)).toMatchObject({ mtimeMs: db.mtimeMs, size: db.size })
      expect(agyMetrics(root, id).turns).toBe(3)
    } finally {
      agy.close()
    }
  })

  it('conversa reescrita é contada de novo do zero, sumindo passos ou trocando o que já foi lido', () => {
    const { root, mainFile } = agyFolder()
    expect(agyMetrics(root, MAIN_ID).responses).toHaveLength(1)
    edit(mainFile, (db) => {
      db.exec('delete from steps')
      insertStep(db, 0, userInput)
      insertStep(db, 1, userInput)
    })
    expect(agyMetrics(root, MAIN_ID)).toMatchObject({ turns: 2, responses: [] })
    // Mesmo idx do último passo lido (1), com outro conteúdo.
    edit(mainFile, (db) => {
      db.exec('delete from steps')
      insertStep(db, 0, userInput)
      insertStep(db, 1, RESPONSE)
    })
    expect(agyMetrics(root, MAIN_ID)).toMatchObject({ turns: 1, responses: [{ outputTokens: 8411 }] })
  })

  it('banco ilegível depois de lido mantém os números; nunca lido avisa em vez de mostrar zeros', () => {
    const { root, mainFile } = agyFolder()
    expect(agyMetrics(root, MAIN_ID).responses).toHaveLength(1)
    writeFileSync(mainFile, 'isto não é um banco sqlite, nem mesmo de longe')
    expect(agyMetrics(root, MAIN_ID)).toMatchObject({ turns: 1, responses: [{ outputTokens: 8411 }] })

    const other = emptyFolder()
    const id = randomUUID()
    writeFileSync(join(other, 'conversations', `${id}.db`), 'isto não é um banco sqlite, nem mesmo de longe')
    expect(() => agyMetrics(other, id)).toThrow(/Não deu para ler/)
  })

  it('conversa que aponta para si mesma como mãe não vira subagente dela', () => {
    const root = emptyFolder()
    writeConversation(join(root, 'conversations', `${MAIN_ID}.db`), b64(conversation.metaSubagente), [RESPONSE], new Map([[237, 'gemini-4-carbon']]))
    expect(agyMetrics(root, MAIN_ID)).toMatchObject({ subagents: 0, subagentResponses: [] })
  })

  it('conversa que não existe volta vazia em vez de lançar', () => {
    const { root } = agyFolder()
    expect(agyMetrics(root, randomUUID())).toMatchObject({ responses: [], subagentResponses: [], turns: 0, subagents: 0 })
  })

  it('o dia junta conversas e subagentes mexidos desde o início do período', () => {
    const { root, subFile } = agyFolder()
    const since = RESPONSE_AT - 1000
    expect(agyDay(root, since).map((p) => [p.agent, p.model])).toEqual([
      ['antigravity', 'gemini-4-carbon'],
      ['antigravity', 'gemini-4-carbon']
    ])
    const old = new Date('2020-01-01')
    utimesSync(subFile, old, old)
    expect(agyDay(root, since)).toHaveLength(1)
  })
})

describe('o agy entra nas métricas do Kora', () => {
  const sources = (root: string) => ({
    claudeRoot: join(root, 'sem-claude'),
    codexSessions: join(root, 'sem-codex'),
    codexRollout: () => null,
    opencodeDb: '',
    agyRoot: root
  })

  it('a aba do agy pede as métricas da conversa dela', async () => {
    const { root } = agyFolder()
    const m = await sessionMetrics(sources(root), { kind: 'antigravity', sessionId: MAIN_ID }, '')
    expect(m.agent).toBe('antigravity')
    expect(m.responses).toHaveLength(1)
  })

  it('o TPS de hoje inclui as respostas do agy', async () => {
    const { root } = agyFolder()
    const points = await dayMetrics(sources(root), RESPONSE_AT - 1000)
    expect(points.filter((p) => p.agent === 'antigravity')).toHaveLength(2)
  })
})
