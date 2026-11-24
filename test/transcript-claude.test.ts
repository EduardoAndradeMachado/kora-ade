import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeItems, claudePageAfter, claudePageBefore, claudeSkills, claudeStatus } from '../src/main/transcript-claude'
import { opensTerminal } from '../src/shared/agent-commands'
import type { TranscriptItem } from '../src/shared/transcript'
import { agentTranscript } from '../src/main/transcript'
import { claudeProjectDir } from '../src/main/sessions'

// Linhas no formato do Claude Code 2.1 (capturadas de transcripts reais e anonimizadas; só os campos que contam).
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user', uuid, timestamp: '2026-11-15T12:38:19.934Z', isSidechain: false, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content }, ...extra
})
const assistant = (uuid: string, content: unknown[]): Record<string, unknown> => ({
  type: 'assistant', uuid, timestamp: '2026-11-15T12:38:25.000Z', isSidechain: false, message: { id: 'msg_1', type: 'message', role: 'assistant', content }
})
const noise = (n: number): Record<string, unknown> => ({ type: 'file-history-snapshot', messageId: `m${n}`, snapshot: { trackedFileBackups: {} } })

describe('claudeItems', () => {
  it('mensagem digitada vira balão, sem os lembretes injetados', () => {
    expect(claudeItems(user('u1', 'oi <system-reminder>contexto</system-reminder>'))).toEqual([
      { kind: 'user', id: 'u1:user', at: '2026-11-15T12:38:19.934Z', text: 'oi', images: 0, truncated: false }
    ])
  })

  it('resposta com texto, raciocínio e ferramenta: o raciocínio fica de fora', () => {
    const items = claudeItems(assistant('a1', [
      { type: 'thinking', thinking: 'segredo', signature: 'x' },
      { type: 'text', text: 'Vou ler o arquivo.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\p\\src\\a.ts' } }
    ]))
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'tool'])
    expect(items[1]).toMatchObject({ toolId: 'toolu_1', name: 'Read', summary: 'C:\\p\\src\\a.ts' })
  })

  it('Bash resume pela descrição, e o resultado com erro aponta para a chamada', () => {
    expect(claudeItems(assistant('a2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls -la', description: 'Listar arquivos' } }]))[0]).toMatchObject({ summary: 'Listar arquivos' })
    const result = claudeItems(user('u2', [{ type: 'tool_result', tool_use_id: 't2', content: 'x'.repeat(5000), is_error: true }]))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: 'result', toolId: 't2', error: true, truncated: true })
    expect((result[0] as Extract<TranscriptItem, { kind: 'result' }>).text.length).toBeLessThan(1600)
  })

  it('notificação de tarefa, comando de barra e compactação viram nota', () => {
    const task = '<task-notification>\n<task-id>a</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n<result>longo</result>\n</task-notification>'
    expect(claudeItems(user('u3', task, { origin: { kind: 'task-notification' }, promptSource: 'system' }))).toEqual([
      { kind: 'note', id: 'u3:note', at: '2026-11-15T12:38:19.934Z', text: 'Agent "x" finished' }
    ])
    expect(claudeItems(user('u4', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'))[0]).toMatchObject({ kind: 'note', text: '/clear' })
    expect(claudeItems({ type: 'system', subtype: 'compact_boundary', uuid: 's1', content: 'Conversation compacted' })[0]).toMatchObject({ kind: 'note', text: 'Conversa compactada' })
  })

  it('mensagem enfileirada (escrita com o agente trabalhando) aparece como balão', () => {
    const queued = { type: 'attachment', uuid: 'q1', timestamp: 't', attachment: { type: 'queued_command', prompt: 'e o teste?', commandMode: 'prompt', origin: { kind: 'human' } } }
    expect(claudeItems(queued)).toMatchObject([{ kind: 'user', text: 'e o teste?' }])
    expect(claudeItems({ ...queued, attachment: { ...queued.attachment, commandMode: 'task-notification' } })).toEqual([])
  })

  it('meta, subagente, resumo da compactação e tipos desconhecidos não aparecem', () => {
    expect(claudeItems(user('m', 'Caveat', { isMeta: true }))).toEqual([])
    expect(claudeItems(user('s', 'tarefa do subagente', { isSidechain: true }))).toEqual([])
    expect(claudeItems(user('c', 'This session is being continued…', { isCompactSummary: true }))).toEqual([])
    expect(claudeItems({ type: 'api-request-blob', uuid: 'z', message: { content: [{ type: 'text', text: 'x' }] } })).toEqual([])
    expect(claudeItems(noise(1))).toEqual([])
  })
})

describe('paginação do transcript', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kora-transcript-'))
    file = join(dir, 's.jsonl')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Linhas grandes (até ~150 KB, acentos inclusos) atravessam os blocos de 256 KB da leitura para trás.
  function conversation(count: number): string[] {
    const lines: string[] = []
    for (let n = 0; n < count; n++) {
      lines.push(JSON.stringify(noise(n)))
      lines.push(JSON.stringify(user(`u${n}`, `pergunta ${n} ${'ç'.repeat((n * 7919) % 75000)}`)))
      lines.push(JSON.stringify(assistant(`a${n}`, [{ type: 'text', text: `resposta ${n}` }, { type: 'tool_use', id: `t${n}`, name: 'Grep', input: { pattern: `p${n}` } }])))
    }
    return lines
  }
  const ids = (items: TranscriptItem[]): string[] => items.map((i) => i.id)

  it('voltar de página em página dá exatamente a leitura de frente, sem repetir nem pular', async () => {
    writeFileSync(file, conversation(60).join('\n') + '\n')
    // Passa dos 4 MB de uma leitura para frente: o resto vem pedindo de novo a partir do end.
    const all = await claudePageAfter(file, 's', 0)
    expect(all.items.length).toBeLessThan(180)
    for (let more = await claudePageAfter(file, 's', all.end); more.items.length; more = await claudePageAfter(file, 's', all.end)) {
      all.items.push(...more.items)
      all.end = more.end
    }
    expect(all.items).toHaveLength(180)
    const collected: TranscriptItem[] = []
    let page = await claudePageBefore(file, 's', undefined, 7)
    expect(page.end).toBe(all.end)
    collected.unshift(...page.items)
    let guard = 0
    while (!page.atStart && guard++ < 200) {
      page = await claudePageBefore(file, 's', page.start, 7)
      collected.unshift(...page.items)
    }
    expect(ids(collected)).toEqual(ids(all.items))
  })

  it('linha ainda sendo escrita fica de fora e chega pelo after quando termina', async () => {
    const lines = conversation(3)
    const partial = JSON.stringify(user('novo', 'quase lá'))
    writeFileSync(file, lines.join('\n') + '\n' + partial.slice(0, 20))
    const first = await claudePageBefore(file, 's', undefined, 50)
    expect(ids(first.items)).not.toContain('novo:user')
    expect(await claudePageAfter(file, 's', first.end)).toMatchObject({ items: [], end: first.end })
    appendFileSync(file, partial.slice(20) + '\n')
    const next = await claudePageAfter(file, 's', first.end)
    expect(ids(next.items)).toEqual(['novo:user'])
    expect(await claudePageAfter(file, 's', next.end)).toMatchObject({ items: [] })
  })

  it('cursor fora de começo de linha ou além do fim (arquivo reescrito) pede para recomeçar', async () => {
    writeFileSync(file, conversation(3).join('\n') + '\n')
    const page = await claudePageBefore(file, 's', undefined, 2)
    expect(await claudePageBefore(file, 's', page.start + 1, 2)).toMatchObject({ reset: true })
    truncateSync(file, 10)
    expect(await claudePageAfter(file, 's', page.end)).toMatchObject({ reset: true })
  })

  it('sessão nova sem arquivo ainda: página vazia, sem erro', async () => {
    expect(await claudePageBefore(join(dir, 'nada.jsonl'), 's', undefined, 10)).toMatchObject({ items: [], atStart: true })
    expect(await claudePageAfter(join(dir, 'nada.jsonl'), 's', 0)).toMatchObject({ items: [] })
  })
})

describe('status e skills do Claude', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kora-claude-status-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const request = (querySource: string, model: string, effort: string): string =>
    JSON.stringify({ type: 'api-request', sessionId: 's', querySource, params: { model, max_tokens: 1, output_config: { effort } } })

  it('fim de turno vira item com a duração', () => {
    expect(claudeItems({ type: 'system', subtype: 'turn_duration', durationMs: 8123, uuid: 't1', timestamp: 'x' })).toEqual([{ kind: 'turn', id: 't1', at: 'x', durationMs: 8123 }])
  })

  it('esforço e modo vêm da última chamada da conversa principal, não dos subagentes', async () => {
    const file = join(dir, 's.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan', sessionId: 's' }),
      request('repl_main_thread', 'claude-opus-5-5', 'medium'),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 's' }),
      request('repl_main_thread', 'claude-opus-5-5', 'high'),
      request('agent:custom', 'claude-haiku-5-5', 'low'),
      JSON.stringify(noise(1))
    ].join('\n') + '\n')
    expect(await claudeStatus(file)).toEqual({ model: 'claude-opus-5-5', effort: 'high', mode: 'bypassPermissions' })
    expect(await claudeStatus(join(dir, 'nada.jsonl'))).toEqual({})
  })

  it('skills anunciadas no começo da conversa, com plugin no nome', async () => {
    const file = join(dir, 's.jsonl')
    const listing = { type: 'attachment', uuid: 'k', attachment: { type: 'skill_listing', content: '- crm: Gestor de tarefas\n- plugin:skill: Faz algo útil\nlinha solta' } }
    writeFileSync(file, [JSON.stringify(user('u1', 'oi')), JSON.stringify(listing)].join('\n') + '\n')
    expect(await claudeSkills(file)).toEqual([{ name: 'crm', description: 'Gestor de tarefas' }, { name: 'plugin:skill', description: 'Faz algo útil' }])
  })
})

describe('comandos cuja resposta só aparece no terminal', () => {
  it('no Claude, só seletor e painel; nos outros agentes, qualquer comando de barra', () => {
    expect(opensTerminal('claude', '/model opus')).toBe(false)
    expect(opensTerminal('claude', '/model')).toBe(true)
    expect(opensTerminal('claude', '/resume')).toBe(true)
    expect(opensTerminal('claude', '/compact')).toBe(false)
    expect(opensTerminal('claude', 'conserte o /model do app')).toBe(false)
    expect(opensTerminal('codex', '/compact')).toBe(true)
    expect(opensTerminal('antigravity', '/add-dir oi')).toBe(true)
    expect(opensTerminal('antigravity', 'veja o /tmp')).toBe(false)
    expect(opensTerminal('opencode', '/')).toBe(false)
  })
})

describe('novidades com linha maior que a janela de leitura', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kora-claude-grande-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('imagem colada de 5 MB não prende o cursor: a resposta depois dela chega', async () => {
    const file = join(dir, 's.jsonl')
    const big = user('img', [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(5 * 1024 * 1024) } }, { type: 'text', text: 'veja' }])
    writeFileSync(file, [user('u1', 'antes'), big, assistant('a1', [{ type: 'text', text: 'depois' }])].map((l) => JSON.stringify(l)).join('\n') + '\n')
    const seen: string[] = []
    let end = 0
    for (let guard = 0; guard < 10; guard++) {
      const page = await claudePageAfter(file, 's', end)
      seen.push(...page.items.map((i) => i.id))
      if (page.end === end) break
      end = page.end
    }
    expect(seen).toEqual(['u1:user', 'img:user', 'a1:0'])
  })
})

describe('status pelo despachante', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kora-claude-despachante-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('mudança de modo sozinha, sem mensagem nova, atualiza o status', async () => {
    const claudeRoot = join(dir, 'claude')
    const project = join(dir, 'projeto')
    const folder = claudeProjectDir(claudeRoot, project)
    mkdirSync(folder, { recursive: true })
    const file = join(folder, '7b2e4d6f-1a3c-4b5d-8e9f-0a1b2c3d4e5f.jsonl')
    writeFileSync(file, [JSON.stringify(user('u1', 'oi')), JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' })].join('\n') + '\n')
    const sources = { claudeRoot, codexSessions: join(dir, 'x'), codexRollout: () => null, opencodeDb: join(dir, 'x.db'), agyRoot: join(dir, 'agy') }
    const agent = { kind: 'claude' as const, sessionId: '7b2e4d6f-1a3c-4b5d-8e9f-0a1b2c3d4e5f' }
    const first = await agentTranscript(sources, agent, project, { limit: 10 })
    expect(first.status?.mode).toBe('bypassPermissions')
    appendFileSync(file, JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }) + '\n')
    const next = await agentTranscript(sources, agent, project, { after: first.end, limit: 10 })
    expect(next.items).toEqual([])
    expect(next.status?.mode).toBe('plan')
  })
  it('turno longo: o modo gravado antes de 1 MB de ferramentas ainda aparece na primeira página', async () => {
    const claudeRoot = join(dir, 'claude')
    const project = join(dir, 'projeto')
    const folder = claudeProjectDir(claudeRoot, project)
    mkdirSync(folder, { recursive: true })
    const file = join(folder, '7b2e4d6f-1a3c-4b5d-8e9f-0a1b2c3d4e5f.jsonl')
    const tools = Array.from({ length: 20 }, (_, n) => JSON.stringify(user(`r${n}`, [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'x'.repeat(60 * 1024) }])))
    writeFileSync(file, [JSON.stringify({ type: 'permission-mode', permissionMode: 'acceptEdits' }), ...tools].join('\n') + '\n')
    const sources = { claudeRoot, codexSessions: join(dir, 'x'), codexRollout: () => null, opencodeDb: join(dir, 'x.db'), agyRoot: join(dir, 'agy') }
    const first = await agentTranscript(sources, { kind: 'claude', sessionId: '7b2e4d6f-1a3c-4b5d-8e9f-0a1b2c3d4e5f' }, project, { limit: 10 })
    expect(first.status?.mode).toBe('acceptEdits')
  })

})
