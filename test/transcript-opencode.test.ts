import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { opencodeTranscriptPage } from '../src/main/transcript-opencode'
import type { TranscriptItem, TranscriptPage } from '../src/shared/transcript'

// Esquema e formato das linhas do OpenCode v2 (session_v2 + session_message, cada passo do assistente numa linha com
// as partes em content). Só as colunas e campos que o Kora lê; o conteúdo é inventado.
const SID = 'ses_leitura1'
const T0 = 1_795_000_000_000

let dir: string
let file: string
let db: DatabaseSync
let seq: number
let clock: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kora-oc-transcript-'))
  file = join(dir, 'opencode.db')
  db = new DatabaseSync(file)
  db.exec(`
    create table session_v2 (id text primary key, agent text, model text, time_busy integer, time_idle integer);
    create table session_message (
      id text primary key, session_id text not null, type text not null, seq integer not null,
      time_created integer not null, time_updated integer not null, data text not null
    );
    create unique index session_message_session_seq_idx on session_message (session_id, seq);
    create index session_message_session_type_seq_idx on session_message (session_id, type, seq);
  `)
  seq = 0
  clock = T0
  session(SID)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function session(id: string, extra: { agent?: string; variant?: string; busy?: boolean } = {}): void {
  const model = JSON.stringify({ id: 'modelo-x', providerID: 'prov', ...(extra.variant ? { variant: extra.variant } : {}) })
  db.prepare('insert into session_v2 values (?, ?, ?, ?, ?)').run(id, extra.agent ?? 'build', model, extra.busy ? T0 + 10 : T0, extra.busy ? T0 : T0 + 10)
}

const setBusy = (busy: boolean): void => {
  db.prepare('update session_v2 set time_busy = ?, time_idle = ? where id = ?').run(busy ? clock + 1 : clock, busy ? clock : clock + 1, SID)
}

// Linha nova; o seq pula como no banco real (o OpenCode numera os eventos da sessão, não só as mensagens).
function insert(type: string, data: Record<string, unknown>, sessionId = SID): string {
  seq += 3
  clock += 1000
  const id = `msg_${String(seq).padStart(6, '0')}`
  db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, type, seq, clock, clock, JSON.stringify(data))
  return id
}

const update = (id: string, data: Record<string, unknown>): void => {
  clock += 1000
  db.prepare('update session_message set data = ?, time_updated = ? where id = ?').run(JSON.stringify(data), clock, id)
}

const user = (text: string, files: unknown[] = []): Record<string, unknown> => ({ time: { created: clock + 1000 }, text, files, agents: [] })

type Part = Record<string, unknown>
const reasoning = (text: string): Part => ({ type: 'reasoning', text, time: { created: clock, completed: clock } })
const text = (value: string): Part => ({ type: 'text', text: value })
function tool(id: string, name: string, input: Record<string, unknown>, status: string, output = '', metadata: Record<string, unknown> = {}): Part {
  const state = status === 'error'
    ? { status, input, error: { type: 'tool.execution', message: output } }
    : status === 'completed' ? { status, input, content: [{ type: 'text', text: output }], metadata: { truncated: false, ...metadata } }
      : { status, input }
  return { type: 'tool', id, name, executed: false, state, time: { created: clock, ...(status === 'completed' || status === 'error' ? { ran: clock, completed: clock } : {}) } }
}
function step(content: Part[], stage: 'drafting' | 'streamed' | 'completed' = 'completed', extra: Record<string, unknown> = {}): Record<string, unknown> {
  const time = { created: clock + 1000, firstToken: clock + 1000, ...(stage !== 'drafting' ? { streamed: clock + 1000 } : {}), ...(stage === 'completed' ? { completed: clock + 1000 } : {}) }
  return { time, agent: 'build', model: { id: 'modelo-x', providerID: 'prov', variant: 'low' }, content, ...(stage === 'completed' ? { finish: 'stop', cost: 0 } : {}), ...extra }
}
const idle = (outcome = 'succeeded'): Record<string, unknown> => ({ time: { created: clock + 1000 }, outcome })

const page = (cursor: { before?: number; after?: number; limit?: number } = {}, sessionId = SID): Promise<TranscriptPage> =>
  opencodeTranscriptPage(file, sessionId, { limit: 50, ...cursor })
const ids = (items: TranscriptItem[]): string[] => items.map((i) => i.id)
const kinds = (items: TranscriptItem[]): string[] => items.map((i) => i.kind)
const find = <K extends TranscriptItem['kind']>(items: TranscriptItem[], kind: K): Extract<TranscriptItem, { kind: K }>[] =>
  items.filter((i): i is Extract<TranscriptItem, { kind: K }> => i.kind === kind)

// Tudo que existe, lido para frente desde o começo.
async function readAll(): Promise<TranscriptPage> {
  const all = await page({ after: 0 })
  for (let more = await page({ after: all.end }); more.end !== all.end; more = await page({ after: all.end })) {
    all.items.push(...more.items)
    all.end = more.end
  }
  return all
}

describe('mapeamento das linhas do OpenCode', () => {
  it('mensagem da pessoa com imagem vira balão; instruções e lembretes para o modelo não aparecem', async () => {
    insert('agent-switched', { time: { created: clock }, agent: 'plan', previous: 'build' })
    insert('system', { metadata: { notice: 'instructions', instructionSources: ['AGENTS.md'] }, time: { created: clock }, text: 'regras do projeto', description: 'Instruções' })
    insert('user', user('olha esse print', [{ data: 'x', mime: 'image/png', source: 'clipboard', name: 'a.png' }, { data: 'y', mime: 'application/pdf', source: 'file', name: 'b.pdf' }]))
    insert('synthetic', { time: { created: clock }, text: '<system-reminder>contexto</system-reminder>' })
    insert('synthetic', { metadata: { instruction: 'x' }, time: { created: clock }, text: 'conteúdo do AGENTS.md', description: 'Loaded AGENTS.md' })
    const { items } = await page()
    expect(items).toMatchObject([
      { kind: 'note', text: 'Agente: plan' },
      { kind: 'user', text: 'olha esse print', images: 1, truncated: false }
    ])
    expect(items[1]!.at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('passo do assistente: texto, chamadas com resumo e resultado ligado pelo id; raciocínio fica de fora', async () => {
    insert('user', user('roda os testes'))
    insert('assistant', step([
      reasoning('pensando em segredo'),
      text('Vou ler e rodar.'),
      tool('call_read', 'read', { path: 'C:\\p\\src\\a.ts', limit: 10 }, 'completed', 'conteúdo'),
      tool('call_sh', 'shell', { command: 'pnpm test', description: 'Rodar a suíte' }, 'completed', 'falhou', { exit: 1 }),
      tool('call_grep', 'grep', { pattern: 'TODO', path: '.' }, 'completed', '3 matches', { exit: 0 }),
      tool('call_sub', 'subagent', { agent: 'explore', description: 'Achar o leitor', prompt: 'longo' }, 'error', 'subagente caiu')
    ]))
    const { items } = await page()
    expect(kinds(items)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'result', 'result', 'result', 'result'])
    expect(JSON.stringify(items)).not.toContain('segredo')
    expect(find(items, 'tool').map((t) => [t.toolId, t.name, t.summary])).toEqual([
      ['call_read', 'read', 'C:\\p\\src\\a.ts'],
      ['call_sh', 'shell', 'Rodar a suíte'],
      ['call_grep', 'grep', 'TODO'],
      ['call_sub', 'subagent', 'explore: Achar o leitor']
    ])
    expect(find(items, 'result').map((r) => [r.toolId, r.text, r.error])).toEqual([
      ['call_read', 'conteúdo', false],
      ['call_sh', 'falhou', true],
      ['call_grep', '3 matches', false],
      ['call_sub', 'subagente caiu', true]
    ])
  })

  it('resultado longo é truncado como no Claude', async () => {
    insert('assistant', step([tool('call_big', 'read', { path: 'x' }, 'completed', 'ç'.repeat(5000))]))
    const [result] = find((await page()).items, 'result')
    expect(result).toMatchObject({ truncated: true })
    expect(result!.text.length).toBeLessThan(1600)
  })

  it('fim de turno com a duração desde a mensagem da pessoa; interrupção vira nota', async () => {
    insert('user', user('primeira'))
    const userAt = clock
    insert('assistant', step([text('ok')]))
    insert('idle', idle())
    const firstIdleAt = clock
    insert('user', user('segunda'))
    const secondUserAt = clock
    insert('assistant', step([text('parcial')], 'streamed', { error: { type: 'aborted', message: 'The operation was aborted.' } }))
    insert('idle', idle('interrupted'))
    const interruptedAt = clock
    // Subagente em segundo plano terminou e acordou o agente sem mensagem da pessoa.
    insert('synthetic', { metadata: { source: 'subagent', childID: 'ses_f', agent: 'explore', state: 'completed' }, time: { created: clock }, text: 'r', description: 'Busca' })
    const wokeAt = clock
    insert('assistant', step([text('visto')]))
    insert('idle', idle())
    const { items } = await page()
    expect(kinds(items)).toEqual(['user', 'assistant', 'turn', 'user', 'assistant', 'note', 'turn', 'note', 'assistant', 'turn'])
    const turns = find(items, 'turn')
    expect(turns[0]!.durationMs).toBe(firstIdleAt - userAt)
    expect(turns[1]!.durationMs).toBe(interruptedAt - secondUserAt)
    expect(turns[2]!.durationMs).toBe(clock - wokeAt)
    expect(find(items, 'note')[0]!.text).toBe('Interrompido')
  })

  it('erro do provedor, compactação, comando em segundo plano e subagente viram notas', async () => {
    insert('assistant', step([], 'streamed', { finish: 'error', error: { type: 'provider.quota', message: 'Limite da conta atingido' } }))
    insert('idle', idle('failed'))
    insert('compaction', { metadata: { keepID: 'k' }, time: { created: clock }, status: 'completed', reason: 'auto', summary: 'resumo para o modelo' })
    insert('synthetic', { metadata: { source: 'shell', shellID: 's', jobID: 'j', state: 'completed', truncated: false, exit: 2 }, time: { created: clock }, text: 'saída', description: 'pnpm build' })
    insert('synthetic', { metadata: { source: 'subagent', childID: 'ses_x', agent: 'explore', state: 'completed' }, time: { created: clock }, text: 'relatório', description: 'Mapear o esquema' })
    insert('model-switched', { time: { created: clock }, model: { id: 'outro', providerID: 'prov', variant: 'high' }, previous: { id: 'modelo-x' } })
    const { items } = await page()
    expect(items.filter((i) => i.kind === 'note').map((i) => (i as { text: string }).text)).toEqual([
      'Limite da conta atingido',
      'Conversa compactada automaticamente',
      'Comando em segundo plano terminou com erro (saída 2): pnpm build',
      'Subagente terminou: Mapear o esquema',
      'Modelo: outro (high)'
    ])
    expect(JSON.stringify(items)).not.toContain('resumo para o modelo')
  })

  it('status: agente e variante da sessão; variante default não vira esforço', async () => {
    session('ses_plano', { agent: 'plan', variant: 'high' })
    session('ses_padrao', { variant: 'default' })
    expect((await page({}, 'ses_plano')).status).toEqual({ mode: 'plan', model: 'modelo-x', effort: 'high' })
    expect((await page({}, 'ses_padrao')).status).toEqual({ mode: 'build', model: 'modelo-x' })
  })
})

describe('paginação', () => {
  function conversation(turns: number): void {
    db.exec('begin')
    for (let n = 0; n < turns; n++) {
      insert('user', user(`pergunta ${n}`))
      insert('assistant', step([reasoning('r'), text(`resposta ${n}`), tool(`c${n}a`, 'read', { path: `f${n}` }, 'completed', 'x'), tool(`c${n}b`, 'grep', { pattern: `p${n}` }, 'completed', 'y')]))
      insert('assistant', step([text(`fim ${n}`)]))
      insert('idle', idle())
      // Trecho longo sem conversa: a página para trás não pode pular nem prender o laço nele.
      if (n === 7) for (let k = 0; k < 450; k++) insert('system', { metadata: { notice: 'instructions' }, time: { created: clock }, text: 'x' })
    }
    db.exec('commit')
  }

  it('voltar de página em página dá exatamente a leitura de frente, sem repetir nem pular', async () => {
    conversation(40)
    const all = await readAll()
    expect(all.items).toHaveLength(40 * 8)
    expect(new Set(ids(all.items)).size).toBe(all.items.length)
    const collected: TranscriptItem[] = []
    let current = await page({ limit: 7 })
    expect(current.end).toBe(all.end)
    collected.unshift(...current.items)
    let guard = 0
    while (!current.atStart && guard++ < 300) {
      current = await page({ before: current.start, limit: 7 })
      collected.unshift(...current.items)
    }
    expect(current.atStart).toBe(true)
    expect(ids(collected)).toEqual(ids(all.items))
  })

  it('mensagem nova chega pelo after, uma vez só', async () => {
    conversation(2)
    const first = await page()
    expect(await page({ after: first.end })).toMatchObject({ items: [], end: first.end })
    insert('user', user('mais uma'))
    insert('assistant', step([text('feito')]))
    const next = await page({ after: first.end })
    expect(kinds(next.items)).toEqual(['user', 'assistant'])
    expect(await page({ after: next.end })).toMatchObject({ items: [], end: next.end })
  })

  it('passo em andamento: nada do esboço sai, a chamada chega com o streaming, o resultado quando a ferramenta termina', async () => {
    setBusy(true)
    insert('user', user('roda'))
    const draft = step([reasoning(''), text(''), tool('call_long', 'shell', { comm: '' }, 'streaming')], 'drafting')
    const stepId = insert('assistant', draft)
    const seen: TranscriptItem[] = []
    const p1 = await page()
    expect(kinds(p1.items)).toEqual(['user'])
    seen.push(...p1.items)

    const tools = (long: string, fast: string, after: string): Part[] => [
      tool('call_fast', 'read', { path: 'a' }, fast, 'ok'),
      tool('call_long', 'shell', { command: 'pnpm test' }, long, 'passou', { exit: 0 }),
      tool('call_after', 'grep', { pattern: 'x' }, after, 'nada')
    ]
    update(stepId, step([reasoning('r'), text('Rodando a suíte.'), ...tools('running', 'running', 'running')], 'streamed'))
    const p2 = await page({ after: p1.end })
    expect(kinds(p2.items)).toEqual(['assistant', 'tool', 'tool', 'tool'])
    expect(find(p2.items, 'tool')[1]).toMatchObject({ toolId: 'call_long', summary: 'pnpm test' })
    seen.push(...p2.items)

    // A primeira termina e sai; a terceira também termina, mas espera a segunda: os resultados saem na ordem das partes.
    update(stepId, step([reasoning('r'), text('Rodando a suíte.'), ...tools('running', 'completed', 'completed')], 'streamed'))
    const p3 = await page({ after: p2.end })
    expect(find(p3.items, 'result').map((r) => r.toolId)).toEqual(['call_fast'])
    expect(await page({ after: p3.end })).toMatchObject({ items: [], end: p3.end })
    seen.push(...p3.items)

    update(stepId, step([reasoning('r'), text('Rodando a suíte.'), ...tools('completed', 'completed', 'completed')], 'completed'))
    const p4 = await page({ after: p3.end })
    expect(find(p4.items, 'result').map((r) => r.toolId)).toEqual(['call_long', 'call_after'])
    seen.push(...p4.items)

    insert('assistant', step([text('Tudo verde.')]))
    insert('idle', idle())
    setBusy(false)
    const p5 = await page({ after: p4.end })
    expect(kinds(p5.items)).toEqual(['assistant', 'turn'])
    seen.push(...p5.items)

    expect(ids(seen)).toEqual(ids((await readAll()).items))
  })

  it('página mais recente com passo em andamento termina antes dele, e o after continua de lá', async () => {
    setBusy(true)
    conversation(3)
    const stepId = insert('assistant', step([text('')], 'drafting'))
    // Mensagem enfileirada gravada com o passo ainda aberto: vem depois dele, então espera junto.
    const queued = insert('user', user('enfileirada'))
    const latest = await page({ limit: 4 })
    expect(ids(latest.items)).not.toContain(`${stepId}:0`)
    expect(ids(latest.items)).not.toContain(`${queued}:user`)
    update(stepId, step([text('pronto')]))
    insert('idle', idle())
    const next = await page({ after: latest.end })
    expect(ids(next.items)).toEqual([`${stepId}:0`, `${queued}:user`, expect.stringMatching(/:turn$/)])
  })

  it('passo largado no meio (sessão parada) aparece com a ferramenta sem resultado', async () => {
    insert('user', user('roda'))
    insert('assistant', step([tool('call_x', 'shell', { command: 'sleep 999' }, 'running')], 'streamed'))
    const { items } = await page()
    expect(find(items, 'result')).toMatchObject([{ toolId: 'call_x', error: true, text: 'A ferramenta não terminou.' }])
  })

  it('cursor que não vale mais pede para recomeçar', async () => {
    setBusy(true)
    conversation(2)
    const stepId = insert('assistant', step([tool('call_a', 'shell', { command: 'x' }, 'running')], 'streamed'))
    const latest = await page()
    expect(await page({ before: 1.5 })).toMatchObject({ reset: true })
    expect(await page({ after: -1 })).toMatchObject({ reset: true })
    // O end parou no meio da linha do passo; chega uma mensagem depois dela e a linha some (conversa reescrita).
    insert('user', user('enfileirada'))
    expect((await page({ after: latest.end })).reset).toBeUndefined()
    db.prepare('delete from session_message where id = ?').run(stepId)
    expect(await page({ after: latest.end })).toMatchObject({ reset: true, items: [] })
    // Conversa refeita com menos mensagens: um end de linha inteira que passa do fim também não vale.
    const whole = await page()
    db.prepare('delete from session_message where session_id = ?').run(SID)
    seq = 0
    insert('user', user('do zero'))
    expect(await page({ after: whole.end })).toMatchObject({ reset: true })
    expect(await page({ before: whole.end })).toMatchObject({ reset: true })
    // Sessão apagada.
    db.prepare('delete from session_message where session_id = ?').run(SID)
    db.prepare('delete from session_v2 where id = ?').run(SID)
    expect(await page({ after: latest.end })).toMatchObject({ reset: true })
    expect(await page()).toMatchObject({ items: [], atStart: true })
  })
})

describe('banco ou sessão ausentes', () => {
  it('página vazia, sem erro', async () => {
    expect(await opencodeTranscriptPage(join(dir, 'nada.db'), SID, { limit: 10 })).toMatchObject({ items: [], atStart: true, end: 0 })
    expect(await opencodeTranscriptPage('', SID, { after: 0, limit: 10 })).toMatchObject({ items: [] })
    expect(await page({}, 'ses_desconhecida')).toMatchObject({ items: [], atStart: true })
    expect(await page({}, '../fora')).toMatchObject({ items: [] })
    const bare = join(dir, 'sem-tabelas.db')
    new DatabaseSync(bare).close()
    expect(await opencodeTranscriptPage(bare, SID, { limit: 10 })).toMatchObject({ items: [] })
  })

  it('sessão nova ainda sem mensagens: vazia, e a primeira chega pelo after', async () => {
    const first = await page()
    expect(first).toMatchObject({ items: [], atStart: true })
    insert('user', user('oi'))
    expect(kinds((await page({ after: first.end })).items)).toEqual(['user'])
  })
})
