import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeMetrics } from '../src/main/metrics-claude'
import { CodexMetrics } from '../src/main/metrics-codex'
import { opencodeDay, opencodeMetrics } from '../src/main/metrics-opencode'
import { JsonlFollower, sessionMetrics } from '../src/main/metrics'
import { claudeProjectDir } from '../src/main/sessions'
import { closeOpencodeDb } from '../src/main/opencode'

const T0 = Date.parse('2026-10-21T01:00:00.000Z')
const iso = (ms: number): string => new Date(T0 + ms).toISOString()

// Registros no formato do Claude Code 2.1.305: o pedido sai (api-request), a resposta chega em uma linha por
// bloco com o mesmo message.id e o uso final só na última.
function claudeLines(): Record<string, unknown>[] {
  const usage = (output: number) => ({
    input_tokens: 2,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
    output_tokens: output,
    speed: 'standard'
  })
  const assistant = (ms: number, content: unknown[], output: number, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    timestamp: iso(ms),
    gitBranch: 'main',
    effort: 'high',
    requestRef: 'req_1',
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage: usage(output), content },
    ...extra
  })
  return [
    { type: 'user', timestamp: iso(0), message: { role: 'user', content: 'arrume o teste' } },
    { type: 'api-request', id: 'req_1', timestamp: iso(500), querySource: 'repl_main_thread' },
    assistant(3000, [{ type: 'thinking', thinking: '' }], 8),
    assistant(4500, [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:/p/a.ts' } }], 400),
    { type: 'user', timestamp: iso(5000), toolUseResult: { stdout: '' }, message: { content: [{ type: 'tool_result' }] } },
    // Resposta sintética (erro da API) não é resposta do modelo.
    { type: 'assistant', timestamp: iso(5100), message: { id: 'x', model: '<synthetic>', usage: usage(0), content: [] } },
    { type: 'system', subtype: 'turn_duration', durationMs: 6000, timestamp: iso(6000) },
    { type: 'system', subtype: 'compact_boundary', timestamp: iso(6500) },
    { type: 'user', timestamp: iso(7000), message: { content: '<local-command-caveat>x</local-command-caveat>' } },
    { type: 'user', timestamp: iso(8000), message: { content: [{ type: 'text', text: '<system-reminder>r</system-reminder>' }, { type: 'text', text: 'segundo pedido' }] } },
    { type: 'user', timestamp: iso(9000), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }
  ]
}

describe('ClaudeMetrics', () => {
  it('mede a resposta do envio do pedido até o último bloco e usa o uso final', () => {
    const acc = new ClaudeMetrics()
    for (const line of claudeLines()) acc.line(line)
    const m = acc.snapshot('s')

    expect(m.responses).toHaveLength(1)
    const r = m.responses[0]!
    expect(r.durationMs).toBe(4000)
    expect(r.outputTokens).toBe(400)
    expect(r.tps).toBeCloseTo(100)
    expect(r.contextTokens).toBe(101_002)
    // Opus 5.5: entrada 4, cache lido 0,20, gravação de 1 h = 2x a entrada, saída 20 (US$ por milhão).
    expect(r.costUsd).toBeCloseTo((2 * 4 + 100_000 * 0.2 + 1000 * 8 + 400 * 20) / 1_000_000, 10)
  })

  it('liga a resposta ao próprio pedido mesmo com linhas gravadas fora de ordem', () => {
    // Sequência real (transcript e8f15b89): o pedido da resposta seguinte entrou no arquivo antes da anterior.
    const answer = (ms: number, id: string, ref: string, output: number) => ({
      type: 'assistant',
      timestamp: iso(ms),
      requestRef: ref,
      message: { id, model: 'claude-opus-5-5', usage: { output_tokens: output }, content: [{ type: 'tool_use', name: 'Bash', input: {} }] }
    })
    const acc = new ClaudeMetrics()
    for (const line of [
      { type: 'api-request', id: 'r1', timestamp: iso(21_467) },
      { type: 'user', timestamp: iso(21_438), toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } },
      { type: 'api-request', id: 'r2', timestamp: iso(23_929) },
      answer(23_872, 'x', 'r1', 145),
      { type: 'user', timestamp: iso(23_906), toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } },
      answer(33_087, 'y', 'r2', 627)
    ])
      acc.line(line)

    expect(acc.snapshot('s').responses.map((r) => r.durationMs)).toEqual([2405, 9158])
  })

  it('sem requestRef usa o último evento e nunca vira duração negativa', () => {
    const acc = new ClaudeMetrics()
    acc.line({ type: 'user', timestamp: iso(0), message: { content: 'oi' } })
    acc.line({ type: 'assistant', timestamp: iso(2000), message: { id: 'a', model: 'claude-opus-5-5', usage: { output_tokens: 300 }, content: [] } })
    acc.line({ type: 'user', timestamp: iso(5000), toolUseResult: {}, message: { content: [{ type: 'tool_result' }] } })
    acc.line({ type: 'assistant', timestamp: iso(4000), message: { id: 'b', model: 'claude-opus-5-5', usage: { output_tokens: 300 }, content: [] } })

    expect(acc.snapshot('s').responses.map((r) => [r.durationMs, r.tps])).toEqual([
      [2000, 150],
      [null, null]
    ])
  })

  it('conta turnos, interrupções e compactações', () => {
    const acc = new ClaudeMetrics()
    for (const line of claudeLines()) acc.line(line)
    const m = acc.snapshot('s')

    // Comando local (<local-command-caveat>) não conta; pedido que começa com lembrete do sistema conta.
    expect(m.turns).toBe(2)
    expect(m.interruptions).toBe(1)
    expect(m.compactions).toBe(1)
    expect(m.contextWindow).toBe(1_000_000)
  })
})

describe('CodexMetrics', () => {
  // Formato do Codex 0.163: cada chamada ao modelo grava token_usage_record; o token_count repete o mesmo uso
  // e traz os limites do plano.
  const lines = (): Record<string, unknown>[] => [
    { type: 'session_meta', timestamp: iso(0), payload: { context_window: 258_400 } },
    { type: 'turn_context', timestamp: iso(0), payload: { model: 'gpt-6.1-sol', collaboration_mode: { settings: { reasoning_effort: 'high' } } } },
    { type: 'event_msg', timestamp: iso(1000), payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: iso(3000), payload: { type: 'custom_tool_call', name: 'exec' } },
    {
      type: 'token_usage_record',
      timestamp: iso(3000),
      payload: { usage: { input_tokens: 10_000, cached_input_tokens: 8000, cache_write_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 50 } }
    },
    {
      type: 'event_msg',
      timestamp: iso(3010),
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10_000, output_tokens: 200 }, model_context_window: 258_400 },
        rate_limits: { primary: { used_percent: 34, resets_at: 1_793_099_203 }, credits: { balance: '10' } }
      }
    },
    { type: 'response_item', timestamp: iso(9000), payload: { type: 'custom_tool_call_output' } },
    {
      type: 'token_usage_record',
      timestamp: iso(11_000),
      payload: { usage: { input_tokens: 12_000, cached_input_tokens: 10_000, output_tokens: 300, reasoning_output_tokens: 0 } }
    },
    { type: 'event_msg', timestamp: iso(11_100), payload: { type: 'task_complete', duration_ms: 10_100, time_to_first_token_ms: 1500 } },
    { type: 'compacted', timestamp: iso(12_000), payload: {} },
    { type: 'event_msg', timestamp: iso(13_000), payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: iso(14_000), payload: { type: 'turn_aborted', duration_ms: 1000 } }
  ]

  it('cada resposta começa no último evento de entrada (início do turno ou saída de ferramenta)', () => {
    const acc = new CodexMetrics()
    for (const line of lines()) acc.line(line)
    const m = acc.snapshot('t')

    expect(m.responses.map((r) => r.durationMs)).toEqual([2000, 2000])
    expect(m.responses[0]!.tps).toBeCloseTo(100)
    // O input da OpenAI inclui o cache: só 2000 tokens foram cobrados como entrada nova.
    expect(m.responses[0]!.inputTokens).toBe(2000)
    expect(m.responses[0]!.costUsd).toBeCloseTo((2000 * 2 + 8000 * 0.1 + 200 * 10) / 1_000_000, 10)
  })

  it('lê turnos, interrupção e compactação', () => {
    const acc = new CodexMetrics()
    for (const line of lines()) acc.line(line)
    const m = acc.snapshot('t')

    expect(m.turns).toBe(2)
    expect(m.interruptions).toBe(1)
    expect(m.compactions).toBe(1)
    expect(m.contextWindow).toBe(258_400)
  })

  it('versão sem token_usage_record usa o token_count como resposta', () => {
    const acc = new CodexMetrics()
    for (const line of lines().filter((l) => l['type'] !== 'token_usage_record')) acc.line(line)
    expect(acc.snapshot('t').responses).toHaveLength(1)
  })
})

describe('opencodeMetrics', () => {
  afterEach(() => closeOpencodeDb())

  function makeDb(): string {
    const file = join(mkdtempSync(join(tmpdir(), 'kora-metrics-')), 'opencode.db')
    const db = new DatabaseSync(file)
    db.exec(`
      create table session_v2 (id text primary key, parent_id text, version text);
      create table session_message (
        id text primary key, session_id text not null, type text not null, seq integer not null,
        time_created integer not null, data text not null
      );
    `)
    const addTo = (session: string, seq: number, type: string, created: number, data: unknown): void => {
      db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)').run(`${session}-${seq}`, session, type, seq, created, JSON.stringify(data))
    }
    const add = (seq: number, type: string, created: number, data: unknown): void => addTo('ses_a', seq, type, created, data)
    db.prepare('insert into session_v2 values (?, ?, ?)').run('ses_a', null, '2.1.1')
    // Subagente (sessão filha) que lançou outro subagente; a outra conversa não é da ses_a.
    db.prepare('insert into session_v2 values (?, ?, ?)').run('ses_filho', 'ses_a', '2.1.1')
    db.prepare('insert into session_v2 values (?, ?, ?)').run('ses_neto', 'ses_filho', '2.1.1')
    db.prepare('insert into session_v2 values (?, ?, ?)').run('ses_outra', null, '2.1.1')
    const sub = (session: string, model: string, created: number): void =>
      addTo(session, 1, 'assistant', created, {
        time: { created, streamed: created + 1000 },
        model: { id: model, providerID: 'deepseek' },
        finish: 'stop',
        tokens: { output: 200, reasoning: 0 }
      })
    // Antes de T0: fora do recorte do dia usado no teste de opencodeDay.
    sub('ses_filho', 'deepseek-pro', T0 - 20_000)
    sub('ses_neto', 'deepseek-flash', T0 - 10_000)
    sub('ses_outra', 'outro-modelo', T0 - 5000)
    // Mensagem real (sessão "Nome do assistente"), que a TUI mostrou como "1.8s · 36.6 tok/s".
    add(1, 'user', T0, { time: { created: T0 } })
    add(2, 'assistant', T0 + 54, {
      time: { created: T0 + 54, streamed: T0 + 1639, completed: T0 + 1791 },
      agent: 'build',
      model: { id: 'deepseek-flash', providerID: 'deepseek', variant: 'default' },
      finish: 'stop',
      cost: 0.00012,
      tokens: { input: 259, output: 58, reasoning: 0, cache: { read: 8192, write: 0 } },
      content: [{ type: 'text' }, { type: 'tool', name: 'edit', state: { input: { path: 'C:/p/b.ts' } } }]
    })
    add(3, 'idle', T0 + 1795, { time: { created: T0 + 1795 } })
    add(4, 'user', T0 + 5000, { time: { created: T0 + 5000 } })
    add(5, 'compaction', T0 + 5500, {})
    add(6, 'idle', T0 + 6000, { time: { created: T0 + 6000 }, outcome: 'interrupted' })
    db.close()
    return file
  }

  it('calcula o TPS como a TUI do OpenCode e usa o custo gravado', () => {
    const m = opencodeMetrics(makeDb(), 'ses_a')

    expect(m.responses).toHaveLength(1)
    expect(m.responses[0]!.durationMs).toBe(1585)
    expect(m.responses[0]!.tps!.toFixed(1)).toBe('36.6')
    expect(m.responses[0]!.costUsd).toBe(0.00012)
    expect(m.responses[0]!.contextTokens).toBe(8451)
    expect(m.costKind).toBe('real')
  })

  it('conta os pedidos e o turno interrompido', () => {
    const m = opencodeMetrics(makeDb(), 'ses_a')

    expect(m.turns).toBe(2)
    expect(m.interruptions).toBe(1)
    expect(m.compactions).toBe(1)
  })

  it('traz as respostas dos subagentes, inclusive os lançados por subagentes', () => {
    const m = opencodeMetrics(makeDb(), 'ses_a')

    expect(m.subagents).toBe(2)
    expect(m.subagentResponses.map((r) => [r.model, r.tps])).toEqual([
      ['deepseek-pro', 200],
      ['deepseek-flash', 200]
    ])
    expect(m.responses.map((r) => r.model)).toEqual(['deepseek-flash'])
  })

  it('o dia traz só as respostas a partir do horário pedido', () => {
    const file = makeDb()
    expect(opencodeDay(file, T0).map((p) => p.tps.toFixed(1))).toEqual(['36.6'])
    expect(opencodeDay(file, T0 + 60)).toEqual([])
  })
})

describe('JsonlFollower', () => {
  class Collect {
    readonly seen: unknown[] = []
    line(e: Record<string, unknown>): void {
      this.seen.push(e['v'])
    }
  }

  it('processa cada linha uma vez, mesmo chegando pela metade e com caractere cortado', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kora-follow-')), 'a.jsonl')
    const follower = new JsonlFollower(() => new Collect())
    const line = Buffer.from('{"v":"ação"}\n', 'utf8')
    // Corta no meio do "ç" (2 bytes em UTF-8): a CLI pode estar no meio da escrita quando o Kora lê.
    const cut = line.indexOf(Buffer.from('ç', 'utf8')) + 1
    writeFileSync(file, Buffer.concat([Buffer.from('{"v":1}\n'), line.subarray(0, cut)]))
    expect((await follower.read(file))!.seen).toEqual([1])
    appendFileSync(file, line.subarray(cut))
    expect((await follower.read(file))!.seen).toEqual([1, 'ação'])
    expect((await follower.read(file))!.seen).toEqual([1, 'ação'])
  })

  it('arquivo reescrito menor recomeça do zero', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kora-follow-')), 'a.jsonl')
    const follower = new JsonlFollower(() => new Collect())
    writeFileSync(file, '{"v":1}\n{"v":2}\n')
    await follower.read(file)
    writeFileSync(file, '{"v":3}\n')
    expect((await follower.read(file))!.seen).toEqual([3])
  })

  it('leituras simultâneas do mesmo arquivo não processam o trecho duas vezes', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kora-follow-')), 'a.jsonl')
    const follower = new JsonlFollower(() => new Collect())
    writeFileSync(file, '{"v":1}\n{"v":2}\n')
    const [a] = await Promise.all([follower.read(file), follower.read(file)])
    expect(a!.seen).toEqual([1, 2])
  })
})

describe('sessionMetrics com subagentes', () => {
  const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  const answer = (ms: number, id: string, model: string, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    timestamp: iso(ms),
    requestRef: `req-${id}`,
    message: { id, model, usage: { output_tokens: 300 }, content: [] },
    ...extra
  })
  const request = (ms: number, id: string, extra: Record<string, unknown> = {}) => ({ type: 'api-request', id: `req-${id}`, timestamp: iso(ms), ...extra })

  it('Claude: lê <sessão>/subagents/agent-*.jsonl, cujas linhas vêm todas como isSidechain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-claude-'))
    const project = join(root, 'projeto')
    const dir = claudeProjectDir(root, project)
    const sessionId = '0d3106c4-3ce3-4a92-a724-c533662a64d0'
    mkdirSync(join(dir, sessionId, 'subagents'), { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl([request(0, 'p'), answer(3000, 'p', 'claude-opus-5-5')]))
    const side = { isSidechain: true }
    writeFileSync(
      join(dir, sessionId, 'subagents', 'agent-a1.jsonl'),
      jsonl([request(1000, 's1', side), answer(2000, 's1', 'claude-haiku-5-5', side)])
    )
    writeFileSync(join(dir, sessionId, 'subagents', 'agent-a1.meta.json'), '{"model":"haiku"}')

    const m = await sessionMetrics(
      { claudeRoot: root, codexSessions: join(root, 'sem-codex'), codexRollout: () => null, opencodeDb: '' },
      { kind: 'claude', sessionId },
      project
    )

    expect(m.responses.map((r) => r.model)).toEqual(['claude-opus-5-5'])
    expect(m.subagentResponses.map((r) => [r.model, r.tps])).toEqual([['claude-haiku-5-5', 300]])
  })

  it('Codex: segue parent_thread_id até os subagentes dos subagentes e ignora outras conversas', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'kora-codex-'))
    const day = join(sessions, '2026', '10', '20')
    mkdirSync(day, { recursive: true })
    const ids = {
      root: '01a15c20-754e-7862-a430-f52740112e63',
      luna: '01a15c2b-7660-7f71-b2d4-4e87cd8b4b0b',
      neto: '01a15c2b-90ac-71a0-a71b-13c01ff1d4f3',
      outra: '01a15c2b-0000-7000-8000-000000000000'
    }
    const rollout = (id: string, parent: string | null, model: string): string => {
      const file = join(day, `rollout-2026-10-20T22-55-14-${id}.jsonl`)
      const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : 'cli'
      writeFileSync(
        file,
        jsonl([
          { type: 'session_meta', timestamp: iso(0), payload: { id, source } },
          { type: 'turn_context', timestamp: iso(0), payload: { model } },
          { type: 'event_msg', timestamp: iso(1000), payload: { type: 'task_started' } },
          { type: 'token_usage_record', timestamp: iso(3000), payload: { usage: { input_tokens: 10, output_tokens: 400 } } }
        ])
      )
      return file
    }
    const rootFile = rollout(ids.root, null, 'gpt-6.1-sol')
    rollout(ids.luna, ids.root, 'gpt-6-luna')
    rollout(ids.neto, ids.luna, 'gpt-6-astra')
    rollout(ids.outra, '01a10000-0000-7000-8000-000000000000', 'gpt-6-astra')

    const m = await sessionMetrics(
      { claudeRoot: join(sessions, 'sem-claude'), codexSessions: sessions, codexRollout: (id) => (id === ids.root ? rootFile : null), opencodeDb: '' },
      { kind: 'codex', sessionId: ids.root },
      sessions
    )

    expect(m.responses.map((r) => r.model)).toEqual(['gpt-6.1-sol'])
    expect(m.subagentResponses.map((r) => r.model).sort()).toEqual(['gpt-6-astra', 'gpt-6-luna'])
    expect(m.subagentResponses.every((r) => r.tps === 200)).toBe(true)
  })
})
