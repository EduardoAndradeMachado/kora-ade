import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { protoFields } from '../src/main/antigravity-conversations'
import { agyTranscriptPage } from '../src/main/transcript-agy'
import type { TranscriptItem, TranscriptPage } from '../src/shared/transcript'

// Duas respostas reais do modelo (agy 1.5.9, ver "origem" no arquivo): uma que pediu run_command e a final ("ok"),
// com os horários e o código do modelo no campo 5. E o metadata real de uma resposta do agy 1.5.10, com o ponteiro
// para a linha 237 do gen_metadata e o uso de tokens. O resto dos passos é montado aqui com os mesmos campos.
const conversa = JSON.parse(readFileSync(new URL('./fixtures/agy-conversa.json', import.meta.url), 'utf8')) as Record<
  'respostaComFerramenta' | 'respostaFinal',
  { type: number; status: number; payload: string }
>
const metricas = JSON.parse(readFileSync(new URL('./fixtures/agy-metricas.json', import.meta.url), 'utf8')) as {
  resposta: { metadata: string }
}
const b64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'))
const CALL_ID = 'call_902480978430589269'
// Fim da resposta final real (campo 5.7): 2026-11-16T12:14:32.911Z.
const FINAL_AT = 1794831272911

// Protobuf mínimo: chave = campo << 3 | tipo; 0 varint, 2 bytes.
type ProtoValue = number | string | Uint8Array
const varint = (n: number): number[] => {
  const out: number[] = []
  do {
    out.push((n % 0x80) | (n >= 0x80 ? 0x80 : 0))
    n = Math.floor(n / 0x80)
  } while (n > 0)
  return out
}
function proto(fields: [number, ProtoValue][]): Uint8Array {
  const out: Uint8Array[] = []
  for (const [field, value] of fields) {
    if (typeof value === 'number') out.push(new Uint8Array([...varint(field * 8), ...varint(value)]))
    else {
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
      out.push(new Uint8Array([...varint(field * 8 + 2), ...varint(bytes.length)]), bytes)
    }
  }
  return new Uint8Array(Buffer.concat(out))
}
const time = (ms: number): Uint8Array => proto([[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1e6]])

interface Step {
  type: number
  status: number
  metadata: Uint8Array
  payload: Uint8Array
}

const step = (type: number, status: number, meta: [number, ProtoValue][], body: [number, ProtoValue][]): Step => {
  const metadata = proto(meta)
  return { type, status, metadata, payload: proto([[1, type], [4, status], [5, metadata], ...body]) }
}
// O passo real traz o metadata dentro do payload (campo 5), igual à coluna metadata.
const real = (s: { type: number; status: number; payload: string }): Step => {
  const payload = b64(s.payload)
  return { type: s.type, status: s.status, payload, metadata: protoFields(payload).get(5)![0] as Uint8Array }
}

const T0 = Date.parse('2026-11-16T12:14:00.000Z')
const user = (ms: number, text: string): Step => step(14, 3, [[1, time(ms)]], [[19, proto([[2, text], [3, proto([[1, text]])]])]])
const slash = (ms: number, name: string): Step =>
  step(14, 3, [[1, time(ms)]], [[19, proto([[3, proto([[2, proto([[27, proto([[1, name]])]])]])], [3, proto([[1, '']])]])]])
const planner = (ms: number, endMs: number, text: string, calls: [string, string][] = [], status = 3): Step =>
  step(15, status, [[1, time(ms)], [7, time(endMs)]], [[20, proto([...(text ? [[1, text] as [number, ProtoValue]] : []), ...calls.map(([id, name]): [number, ProtoValue] => [7, proto([[1, id], [2, name]])])])]])
const tool = (
  ms: number,
  id: string,
  name: string,
  args: Record<string, unknown>,
  opts: { status?: number; result?: string; error?: string; background?: boolean; endMs?: number } = {}
): Step =>
  step(
    132,
    opts.status ?? 3,
    [[1, time(ms)], [4, proto([[1, id], [2, name], [3, JSON.stringify(args)]])], ...(opts.endMs ? [[8, time(opts.endMs)] as [number, ProtoValue]] : [])],
    [
      ...(opts.error ? [[31, proto([[2, 'file does not exist'], [3, opts.error]])] as [number, ProtoValue]] : []),
      ...(opts.background ? [[148, proto([[7, 'Rodar em segundo plano']])] as [number, ProtoValue]] : []),
      [140, proto([[2, proto(opts.result !== undefined ? [[1, opts.result]] : [])]])]
    ]
  )
const notification = (ms: number, kind: string, title: string | null): Step =>
  step(101, 3, [[1, time(ms)]], [[114, proto([[1, '[Message] para o modelo'], ...(title !== null ? [[2, proto([[1, title]])] as [number, ProtoValue]] : []), [3, kind]])]])

function agyFolder(): { root: string; conversation(steps: Step[]): Conversation } {
  const root = mkdtempSync(join(tmpdir(), 'kora-agy-leitura-'))
  mkdirSync(join(root, 'conversations'))
  return { root, conversation: (steps) => new Conversation(root, steps) }
}

class Conversation {
  readonly id = randomUUID()
  readonly file: string
  constructor(root: string, steps: Step[]) {
    this.file = join(root, 'conversations', `${this.id}.db`)
    this.write((db) => {
      // Os bancos do agy ficam em modo WAL; o leitor abre sem -wal como imutável e com -wal como só-leitura.
      db.exec('pragma journal_mode = wal')
      db.exec('create table steps (idx integer primary key, step_type integer not null default 0, status integer not null default 0, metadata blob, step_payload blob)')
      db.exec('create index idx_steps_status on steps(status)')
      db.exec('create index idx_steps_step_type on steps(step_type)')
      db.exec('create table gen_metadata (idx integer primary key, data blob, size integer not null default 0)')
    })
    this.append(...steps)
  }
  private write(change: (db: DatabaseSync) => void): void {
    const db = new DatabaseSync(this.file)
    try {
      change(db)
    } finally {
      db.close()
    }
  }
  append(...steps: Step[]): void {
    this.write((db) => {
      const next = Number((db.prepare('select coalesce(max(idx) + 1, 0) as n from steps').get() as { n: number }).n)
      const insert = db.prepare('insert into steps (idx, step_type, status, metadata, step_payload) values (?, ?, ?, ?, ?)')
      steps.forEach((s, i) => insert.run(next + i, s.type, s.status, s.metadata, s.payload))
    })
  }
  replace(idx: number, s: Step): void {
    this.write((db) => db.prepare('update steps set step_type = ?, status = ?, metadata = ?, step_payload = ? where idx = ?').run(s.type, s.status, s.metadata, s.payload, idx))
  }
  // O que o /undo do agy faz: apaga os passos do fim, e os próximos reaproveitam os mesmos idx.
  dropFrom(idx: number): void {
    this.write((db) => db.prepare('delete from steps where idx >= ?').run(idx))
  }
  generation(idx: number, data: Uint8Array): void {
    this.write((db) => db.prepare('insert into gen_metadata (idx, data, size) values (?, ?, ?)').run(idx, data, data.length))
  }
}

let agy: ReturnType<typeof agyFolder>
beforeEach(() => {
  agy = agyFolder()
})
afterEach(() => rmSync(agy.root, { recursive: true, force: true }))

const page = (c: { id: string }, cursor: { before?: number; after?: number; limit?: number } = {}): Promise<TranscriptPage> =>
  agyTranscriptPage(agy.root, c.id, { limit: 40, ...cursor })
const ids = (items: TranscriptItem[]): string[] => items.map((i) => i.id)

async function readForward(c: Conversation): Promise<{ items: TranscriptItem[]; end: number; calls: number }> {
  const items: TranscriptItem[] = []
  let end = 0
  let calls = 0
  for (;;) {
    const next = await page(c, { after: end })
    calls++
    expect(next.reset).toBeUndefined()
    items.push(...next.items)
    if (next.end === end) return { items, end, calls }
    end = next.end
  }
}

describe('passos do agy viram itens do modo leitura', () => {
  it('pedido, ferramenta com resultado e resposta final com o tempo do turno', async () => {
    const c = agy.conversation([
      user(T0, 'rode o comando'),
      real(conversa.respostaComFerramenta),
      tool(T0 + 6000, CALL_ID, 'run_command', { CommandLine: 'Start-Sleep -Seconds 20; Write-Output pronto', toolSummary: 'Sleep and output pronto' }, {
        result: 'Created At: 2026-11-16T09:14:06-03:00\nCompleted At: 2026-11-16T09:14:28-03:00\npronto',
        endMs: T0 + 28000
      }),
      real(conversa.respostaFinal)
    ])
    const { items } = await page(c)
    expect(items).toEqual([
      { kind: 'user', id: '0:user', at: '2026-11-16T12:14:00.000Z', text: 'rode o comando', images: 0, truncated: false },
      { kind: 'tool', id: '2:tool', at: '2026-11-16T12:14:06.000Z', toolId: CALL_ID, name: 'run_command', summary: 'Sleep and output pronto' },
      { kind: 'result', id: '2:result', at: '2026-11-16T12:14:28.000Z', toolId: CALL_ID, text: 'pronto', error: false, truncated: false },
      { kind: 'assistant', id: '3:text', at: new Date(FINAL_AT).toISOString(), text: 'ok', truncated: false },
      { kind: 'turn', id: '3:turn', at: new Date(FINAL_AT).toISOString(), durationMs: FINAL_AT - T0 }
    ])
  })

  it('falha, cancelamento, avisos e comando de barra; lembretes para o modelo não aparecem', async () => {
    const c = agy.conversation([
      slash(T0, 'compact'),
      step(23, 3, [[1, time(T0 + 1000)]], [[30, proto([[5, '<summary>resumo</summary>']])]]),
      user(T0 + 2000, 'leia o arquivo'),
      tool(T0 + 3000, 'c1', 'read_file', { Path: 'C:\\p\\a.ts' }, { status: 7, error: 'file does not exist: C:\\p\\a.ts' }),
      tool(T0 + 4000, 'c2', 'run_command', { CommandLine: 'npm test' }, { status: 6 }),
      tool(T0 + 5000, 'c3', 'grep_search', { Query: 'TODO', SearchPath: 'C:\\p' }, { result: 'x'.repeat(5000) }),
      notification(T0 + 6000, 'task_notification', 'Run tests finished'),
      // Os dois lembretes reais: o de eficiência traz só o campo 4 no 114.2; o periódico nem traz o 114.2.
      step(101, 3, [[1, time(T0 + 6500)]], [[114, proto([[1, 'Reminder: work efficiently.'], [2, proto([[4, 'x']])], [3, 'work_efficiently_reminder']])]]),
      notification(T0 + 6600, '', null),
      // O aviso de reinício do servidor que o agy injeta ao retomar a conversa.
      notification(T0 + 6700, '', 'System Message'),
      step(17, 3, [[1, time(T0 + 7000)]], [[24, proto([[3, proto([[1, 'Model produced invalid output.'], [2, 'detalhe']])]])]]),
      planner(T0 + 8000, T0 + 9000, '')
    ])
    const { items } = await page(c)
    expect(items.map((i) => i.kind)).toEqual(['note', 'note', 'user', 'tool', 'result', 'tool', 'result', 'tool', 'result', 'note', 'note', 'turn'])
    expect(items[0]).toMatchObject({ kind: 'note', text: '/compact' })
    expect(items[1]).toMatchObject({ kind: 'note', text: 'Conversa compactada' })
    expect(items[3]).toMatchObject({ name: 'read_file', summary: 'C:\\p\\a.ts' })
    expect(items[4]).toMatchObject({ toolId: 'c1', error: true, text: 'file does not exist: C:\\p\\a.ts' })
    expect(items[6]).toMatchObject({ toolId: 'c2', error: true, text: 'Cancelada.' })
    expect(items[7]).toMatchObject({ name: 'grep_search', summary: 'TODO' })
    const long = items[8] as Extract<TranscriptItem, { kind: 'result' }>
    expect(long).toMatchObject({ toolId: 'c3', error: false, truncated: true })
    expect(long.text.length).toBeLessThan(1600)
    expect(items[9]).toMatchObject({ text: 'Run tests finished' })
    expect(items[10]).toMatchObject({ text: 'Erro do agy: Model produced invalid output.' })
    expect(items[11]).toMatchObject({ kind: 'turn', durationMs: 7000 })
  })

  it('passo apagado pelo /compact: o resumo da ferramenta sai do que o terminal mostrava', async () => {
    const render = proto([[3, proto([[9, proto([[2, proto([[1, 'file:///C:/p/b.ts']])]])]])]])
    const cleared: Step = step(132, 5, [[1, time(T0)], [4, proto([[1, 'c9'], [2, 'read_file']])]], [[140, proto([[2, render]])]])
    const { items } = await page(agy.conversation([cleared, planner(T0 + 1000, T0 + 2000, 'texto que sobrou', [], 5)]))
    expect(items).toMatchObject([
      { kind: 'tool', toolId: 'c9', summary: 'C:\\p\\b.ts' },
      { kind: 'result', toolId: 'c9', text: 'Saída descartada pelo agy.', error: false },
      { kind: 'assistant', text: 'texto que sobrou' }
    ])
  })

  it('barra de status: modelo e raciocínio pela linha do gen_metadata, contexto pelo uso da última resposta', async () => {
    const meta = b64(metricas.resposta.metadata)
    const c = agy.conversation([user(T0, 'oi'), { type: 15, status: 3, metadata: meta, payload: proto([[1, 15], [4, 3], [5, meta], [20, proto([[1, 'oi!']])]]) }])
    c.generation(237, proto([[1, proto([[19, 'gemini-4-carbon'], [21, 'Gemini 4 Carbon (Medium)']])]]))
    expect((await page(c)).status).toEqual({ model: 'gemini-4-carbon', effort: 'medium', contextTokens: 2090 + 311_339 })
  })
})

describe('paginação da conversa do agy', () => {
  // Resultados grandes passam dos 4 MB de uma leitura para frente: o resto vem pedindo de novo a partir do end.
  function longConversation(turns: number): Step[] {
    const steps: Step[] = []
    for (let n = 0; n < turns; n++) {
      const at = T0 + n * 60_000
      steps.push(user(at, `pergunta ${n} ${'ç'.repeat((n * 7919) % 3000)}`))
      steps.push(planner(at + 1000, at + 2000, n % 3 === 0 ? `vou olhar ${n}` : '', [[`a${n}`, 'read_file'], [`b${n}`, 'run_command']]))
      steps.push(tool(at + 3000, `a${n}`, 'read_file', { Path: `C:\\p\\${n}.ts` }, { result: 'y'.repeat(n % 4 === 0 ? 300_000 : 100) }))
      steps.push(tool(at + 3000, `b${n}`, 'run_command', { CommandLine: `echo ${n}`, toolSummary: `eco ${n}` }, { result: `${n}` }))
      steps.push(notification(at + 4000, 'work_efficiently_reminder', null))
      steps.push(planner(at + 5000, at + 9000, `resposta ${n}`))
    }
    return steps
  }

  it('voltar de página em página dá exatamente a leitura de frente, sem repetir nem pular', async () => {
    const c = agy.conversation(longConversation(70))
    const all = await readForward(c)
    expect(all.calls).toBeGreaterThan(2)
    // pedido + 2 ferramentas + 2 resultados + resposta + turno, e o texto de abertura a cada três turnos
    expect(all.items).toHaveLength(70 * 7 + 24)
    expect(new Set(ids(all.items)).size).toBe(all.items.length)
    let current = await page(c, { limit: 7 })
    expect(current.end).toBe(all.end)
    const collected = [...current.items]
    let guard = 0
    while (!current.atStart && guard++ < 500) {
      current = await page(c, { before: current.start, limit: 7 })
      expect(current.reset).toBeUndefined()
      collected.unshift(...current.items)
    }
    expect(ids(collected)).toEqual(ids(all.items))
  })

  it('ferramenta rodando: a chamada aparece, o resultado chega pelo after quando termina, sem repetir', async () => {
    const args = { CommandLine: 'pnpm test', toolSummary: 'Rodar os testes' }
    const c = agy.conversation([user(T0, 'teste'), planner(T0 + 1000, T0 + 2000, 'rodando', [['t1', 'run_command']]), tool(T0 + 3000, 't1', 'run_command', args, { status: 2 })])
    const first = await page(c)
    expect(ids(first.items)).toEqual(['0:user', '1:text', '2:tool'])
    expect(await page(c, { after: first.end })).toMatchObject({ items: [], end: first.end })
    // Voltar a partir do meio do passo (só a chamada entregue) não repete nem perde nada.
    const call = await page(c, { before: first.end, limit: 1 })
    expect(ids(call.items)).toEqual(['2:tool'])
    const older = await page(c, { before: call.start })
    expect(older).toMatchObject({ atStart: true })
    expect(ids(older.items)).toEqual(['0:user', '1:text'])

    c.replace(2, tool(T0 + 3000, 't1', 'run_command', args, { result: 'ok, 10 testes' }))
    const done = await page(c, { after: first.end })
    expect(done.items).toMatchObject([{ kind: 'result', id: '2:result', toolId: 't1', text: 'ok, 10 testes' }])

    // Resposta ainda sendo gerada fica de fora inteira e chega quando termina.
    c.append(planner(T0 + 4000, T0 + 5000, 'parcial', [], 8))
    const generating = await page(c, { after: done.end })
    expect(generating).toMatchObject({ items: [], end: done.end })
    c.replace(3, planner(T0 + 4000, T0 + 5000, 'passou tudo'))
    const final = await page(c, { after: done.end })
    expect(ids(final.items)).toEqual(['3:text', '3:turn'])
    expect(await page(c, { after: final.end })).toMatchObject({ items: [], end: final.end })

    // A leitura do zero dá o mesmo que foi chegando aos pedaços.
    expect(ids((await page(c)).items)).toEqual([...ids(first.items), ...ids(done.items), ...ids(final.items)])
  })

  it('comando em segundo plano não segura o resto da conversa', async () => {
    const c = agy.conversation([
      user(T0, 'suba o servidor'),
      tool(T0 + 1000, 's1', 'run_command', { CommandLine: 'pnpm dev' }, { status: 2, background: true }),
      planner(T0 + 2000, T0 + 3000, 'servidor no ar')
    ])
    expect((await page(c)).items).toMatchObject([
      { kind: 'user' },
      { kind: 'tool', toolId: 's1', summary: 'pnpm dev' },
      { kind: 'result', toolId: 's1', text: 'Rodando em segundo plano.', error: false },
      { kind: 'assistant', text: 'servidor no ar' },
      { kind: 'turn', durationMs: 3000 }
    ])
  })

  it('passo largado rodando (o agy fechou no meio) não segura o pedido seguinte', async () => {
    const c = agy.conversation([
      user(T0, 'espere'),
      tool(T0 + 1000, 's2', 'run_command', { CommandLine: 'sleep 99' }, { status: 2 }),
      user(T0 + 5000, 'e agora?')
    ])
    expect((await page(c)).items).toMatchObject([
      { kind: 'user' },
      { kind: 'tool', toolId: 's2' },
      { kind: 'result', toolId: 's2', text: '(sem resultado gravado)' },
      { kind: 'user', text: 'e agora?' }
    ])
  })

  it('cursor que não veio desta conversa como ela está agora pede para recomeçar', async () => {
    const c = agy.conversation(longConversation(3))
    const latest = await page(c, { limit: 3 })
    expect(latest.atStart).toBe(false)
    expect(await page(c, { after: latest.end + 1 })).toMatchObject({ reset: true })
    expect(await page(c, { before: latest.start + 1 })).toMatchObject({ reset: true })
    expect(await page(c, { after: 2 ** 60 })).toMatchObject({ reset: true })
    // /undo: os dois últimos passos somem e outros dois tomam os mesmos idx.
    c.dropFrom(16)
    c.append(user(T0 + 999_000, 'outra coisa'), planner(T0 + 999_500, T0 + 999_900, 'outra resposta'))
    expect(await page(c, { after: latest.end })).toMatchObject({ reset: true })
    // O começo da página continua valendo: os passos antes dele não mudaram.
    expect((await page(c, { before: latest.start })).reset).toBeUndefined()
    // Conversa encurtada: o cursor passou do fim.
    c.dropFrom(5)
    expect(await page(c, { after: latest.end })).toMatchObject({ reset: true })
  })

  it('conversa sem banco ainda: página vazia, e o after de uma leitura anterior pede para recomeçar', async () => {
    const missing = { id: randomUUID() }
    expect(await page(missing)).toMatchObject({ items: [], start: 0, end: 0, atStart: true })
    expect((await page(missing, { after: 0 })).reset).toBeUndefined()
    expect(await page(missing, { after: 5 * 0x10000 + 7 })).toMatchObject({ reset: true })
    expect(await agyTranscriptPage(agy.root, '../fora', { limit: 10 })).toMatchObject({ items: [] })
  })
})
