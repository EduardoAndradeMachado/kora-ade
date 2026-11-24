import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexItems, codexTranscriptPage } from '../src/main/transcript-codex'
import type { TranscriptItem } from '../src/shared/transcript'

// Linhas no formato do rollout do Codex 0.171 (estrutura dos rollouts reais, conteúdo inventado; só os campos que
// contam). Cada mensagem e ferramenta aparece duas vezes: como response_item (o que vai para o modelo) e como
// event_msg/item_completed (o que a tela mostra).
let ordinal = 0
const line = (type: string, payload: Record<string, unknown>, at = '2026-11-23T20:00:00.000Z'): Record<string, unknown> =>
  ({ timestamp: at, ordinal: ordinal++, type, payload })
const completed = (item: Record<string, unknown>): Record<string, unknown> =>
  line('event_msg', { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item, started_at_ms: 1, completed_at_ms: 2 })
const userMessage = (id: string, text: string, images = 0): Record<string, unknown> =>
  completed({ type: 'UserMessage', id, content: [...Array.from({ length: images }, () => ({ type: 'local_image', path: 'C:\\tmp\\a.png' })), { type: 'text', text, text_elements: [] }] })
const agentMessage = (id: string, text: string): Record<string, unknown> =>
  completed({ type: 'AgentMessage', id, content: [{ type: 'Text', text }], phase: 'final_answer' })
const command = (id: string, cmd: string, output: string, exit = 0): Record<string, unknown> => completed({
  type: 'CommandExecution', id, process_id: '1', command: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', cmd],
  cwd: 'file:///C:/p', parsed_cmd: [{ type: 'unknown', cmd }], source: 'unified_exec_startup', status: exit === 0 ? 'completed' : 'failed',
  aggregated_output: output, exit_code: exit, duration: { secs: 0, nanos: 1000 }
})
const modelUser = (text: string): Record<string, unknown> => line('response_item', { type: 'message', id: 'msg_u', role: 'user', content: [{ type: 'input_text', text }] })
const modelAssistant = (text: string): Record<string, unknown> =>
  line('response_item', { type: 'message', id: 'msg_a', role: 'assistant', content: [{ type: 'output_text', text }], phase: 'final_answer' })
const execCall = (callId: string, cmd: string): Record<string, unknown> =>
  line('response_item', { type: 'custom_tool_call', id: 'ctc', status: 'completed', call_id: callId, name: 'exec', input: `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}}); text(r.output)` })
const execOutput = (callId: string, extra: unknown[] = []): Record<string, unknown> =>
  line('response_item', { type: 'custom_tool_call_output', id: 'ctco', call_id: callId, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, ...extra] })
const turnContext = (effort: string, approval: unknown = 'never', sandbox = 'danger-full-access'): Record<string, unknown> => line('turn_context', {
  turn_id: 'tu', cwd: 'C:\\p', approval_policy: approval, model: 'gpt-x', collaboration_mode: { mode: 'default', settings: { model: 'gpt-x', reasoning_effort: effort } },
  effort, summary: 'none', sandbox_policy: { type: sandbox }
})
const taskStarted = (): Record<string, unknown> => line('event_msg', { type: 'task_started', turn_id: 'tu', started_at: 100, model_context_window: 400000 })
const taskComplete = (durationMs: number, error?: string): Record<string, unknown> =>
  line('event_msg', { type: 'task_complete', turn_id: 'tu', last_agent_message: null, started_at: 100, completed_at: 110, duration_ms: durationMs, ...(error ? { error: { message: error, codex_error_info: 'other' } } : {}) })
const noise = (): Record<string, unknown>[] => [
  line('response_item', { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'gAAAA' }),
  completed({ type: 'Reasoning', id: 'rs', summary_text: ['pensando'], raw_content: [] }),
  line('token_usage_record', { thread_id: 'th', usage: { input_tokens: 10, output_tokens: 2 } }),
  line('event_msg', { type: 'token_count', info: null, rate_limits: null })
]

const items = (entry: Record<string, unknown>): TranscriptItem[] => codexItems(entry, '7')

describe('codexItems', () => {
  it('mensagem do usuário sai do evento; a cópia para o modelo, com AGENTS.md e ambiente, não aparece', () => {
    expect(items(userMessage('u1', 'oi', 2))).toEqual([{ kind: 'user', id: '7', at: '2026-11-23T20:00:00.000Z', text: 'oi', images: 2, truncated: false }])
    expect(items(modelUser('# AGENTS.md instructions for C:\\p\n<INSTRUCTIONS>regras</INSTRUCTIONS>'))).toEqual([])
    expect(items(modelUser('<environment_context>\n  <cwd>C:\\p</cwd>\n</environment_context>'))).toEqual([])
    expect(items(modelUser('oi'))).toEqual([])
  })

  it('resposta sai do evento; a cópia para o modelo e o raciocínio ficam de fora', () => {
    expect(items(agentMessage('m1', 'Pronto.'))).toMatchObject([{ kind: 'assistant', text: 'Pronto.' }])
    expect(items(modelAssistant('Pronto.'))).toEqual([])
    for (const entry of noise()) expect(items(entry)).toEqual([])
  })

  it('comando vira ferramenta com o resultado ligado pelo id; o script do modo código não aparece', () => {
    const [tool, result] = items(command('exec-1', 'git status --short', ' M a.ts\n'))
    expect(tool).toEqual({ kind: 'tool', id: '7', at: '2026-11-23T20:00:00.000Z', toolId: 'exec-1', name: 'shell', summary: 'git status --short' })
    expect(result).toMatchObject({ kind: 'result', toolId: 'exec-1', text: ' M a.ts', error: false, truncated: false })
    expect(items(execCall('call_1', 'git status --short'))).toEqual([])
    expect(items(execOutput('call_1'))).toEqual([])
  })

  it('código de saída diferente de zero é erro, e a saída longa é cortada', () => {
    const [, result] = items(command('exec-2', 'pnpm test', 'falhou '.repeat(1000), 2))
    expect(result).toMatchObject({ kind: 'result', toolId: 'exec-2', error: true, truncated: true })
    expect((result as Extract<TranscriptItem, { kind: 'result' }>).text.length).toBeLessThan(1600)
    expect((items(command('exec-3', 'false', '', 1))[1] as Extract<TranscriptItem, { kind: 'result' }>).text).toBe('[código de saída 1]')
  })

  it('edição, MCP, busca na web e imagem viram ferramenta com resultado', () => {
    const patch = items(completed({
      type: 'FileChange', id: 'exec-4', status: 'completed', stdout: 'Success. Updated the following files:\nM src/a.ts\n', stderr: '',
      changes: { 'C:\\p\\src\\a.ts': { type: 'update', unified_diff: '@@', move_path: null }, 'C:\\p\\README.md': { type: 'add', content: 'x' } }
    }))
    expect(patch).toMatchObject([{ kind: 'tool', name: 'apply_patch', summary: 'a.ts, README.md', toolId: 'exec-4' }, { kind: 'result', toolId: 'exec-4', error: false }])
    const mcp = items(completed({
      type: 'McpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', arguments: { query: [{ q: 'vitest mock' }] }, status: 'failed',
      result: { content: [{ type: 'text', text: 'tempo esgotado' }], isError: true }
    }))
    expect(mcp).toMatchObject([{ kind: 'tool', name: 'docs.search', summary: 'vitest mock' }, { kind: 'result', toolId: 'mcp-1', text: 'tempo esgotado', error: true }])
    const web = items(completed({
      type: 'Extension', kind: 'web.search', id: 'ws-1', query: 'node fs read', action: { type: 'search', queries: ['node fs read'] },
      results: [{ type: 'text_result', title: 'File system', url: 'https://nodejs.org/api/fs.html' }]
    }))
    expect(web).toMatchObject([{ kind: 'tool', name: 'web_search', summary: 'node fs read' }, { kind: 'result', toolId: 'ws-1', text: 'File system — https://nodejs.org/api/fs.html' }])
    expect(items(completed({ type: 'ImageView', id: 'iv-1', path: 'file:///C:/tmp/tela.png' }))).toMatchObject([{ kind: 'tool', name: 'view_image', summary: 'C:\\tmp\\tela.png' }, { kind: 'result', toolId: 'iv-1' }])
    expect(items(completed({ type: 'Extension', kind: 'clock.sleep', id: 'cs', durationMs: 30000 }))).toEqual([])
  })

  it('fim de turno, erro, interrupção, compactação e subagente', () => {
    expect(items(taskComplete(8200))).toEqual([{ kind: 'turn', id: '7', at: '2026-11-23T20:00:00.000Z', durationMs: 8200 }])
    expect(items(taskComplete(500, 'unexpected status 401 Unauthorized'))).toMatchObject([{ kind: 'note', text: 'Erro: unexpected status 401 Unauthorized' }, { kind: 'turn', durationMs: 500 }])
    expect(items(line('event_msg', { type: 'turn_aborted', turn_id: 'tu', reason: 'interrupted', started_at: 100 }))).toMatchObject([{ kind: 'note', text: 'Interrompido' }, { kind: 'turn', durationMs: null }])
    expect(items(line('compacted', { message: '', replacement_history: [] }))).toMatchObject([{ kind: 'note', text: 'Conversa compactada' }])
    expect(items(completed({ type: 'ContextCompaction', id: 'cc' }))).toEqual([])
    const sub = (kind: string): Record<string, unknown> => completed({ type: 'SubAgentActivity', id: 'sa', kind, agent_thread_id: 'x', agent_path: '/root/revisor' })
    expect(items(sub('started'))).toMatchObject([{ kind: 'note', text: 'Subagente revisor começou' }])
    expect(items(sub('interacted'))).toEqual([])
    expect(items(taskStarted())).toEqual([])
  })

  it('versão sem item_completed: mensagens dos eventos antigos', () => {
    expect(items(line('event_msg', { type: 'user_message', message: 'revise o diff', images: [], local_images: ['a.png'] }))).toMatchObject([{ kind: 'user', text: 'revise o diff', images: 1 }])
    expect(items(line('event_msg', { type: 'agent_message', message: 'Feito.' }))).toMatchObject([{ kind: 'assistant', text: 'Feito.' }])
  })
})

describe('paginação do rollout', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kora-codex-'))
    file = join(dir, 'rollout-2026-11-23T20-00-00-th.jsonl')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Turnos completos, com cada mensagem e comando gravados nas duas formas. Imagens em base64 (até ~600 KB) e
  // saídas com acento atravessam os blocos de 256 KB da leitura para trás.
  function rollout(turns: number, effort = (n: number): string => (n % 2 ? 'high' : 'low')): string[] {
    const lines: Record<string, unknown>[] = [line('session_meta', { id: 'th', cwd: 'C:\\p', cli_version: '0.171.0', base_instructions: { text: 'b'.repeat(20000) } })]
    for (let n = 0; n < turns; n++) {
      lines.push(taskStarted(), turnContext(effort(n)), modelUser(`<environment_context><cwd>C:\\p</cwd></environment_context>`), modelUser(`pergunta ${n}`), userMessage(`u${n}`, `pergunta ${n}`))
      lines.push(...noise(), execCall(`call_${n}`, `rg p${n}`), command(`exec-${n}`, `rg p${n}`, `saída ${'ç'.repeat((n * 7919) % 60000)}`, n % 5 === 0 ? 1 : 0))
      lines.push(execOutput(`call_${n}`, n % 3 === 0 ? [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(200000 + ((n * 104729) % 400000))}` }] : []))
      lines.push(modelAssistant(`resposta ${n}`), agentMessage(`m${n}`, `resposta ${n}`), taskComplete(1000 + n))
    }
    return lines.map((l) => JSON.stringify(l))
  }
  const ids = (list: TranscriptItem[]): string[] => list.map((i) => i.id)

  it('voltar de página em página dá exatamente a leitura de frente, sem repetir nem pular', async () => {
    writeFileSync(file, rollout(40).join('\n') + '\n')
    // Passa dos 4 MB de uma leitura para frente: o resto vem pedindo de novo a partir do end.
    const all = await codexTranscriptPage(file, 'th', { after: 0, limit: 0 })
    expect(all.items.length).toBeLessThan(200)
    for (let more = await codexTranscriptPage(file, 'th', { after: all.end, limit: 0 }); more.items.length; more = await codexTranscriptPage(file, 'th', { after: all.end, limit: 0 })) {
      all.items.push(...more.items)
      all.end = more.end
    }
    // Por turno: pergunta, ferramenta, resultado, resposta e o fim do turno. Nada da cópia para o modelo.
    expect(all.items.map((i) => i.kind).slice(0, 5)).toEqual(['user', 'tool', 'result', 'assistant', 'turn'])
    expect(all.items).toHaveLength(200)
    expect(all.items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual(Array.from({ length: 40 }, (_, n) => `pergunta ${n}`))
    const tools = all.items.filter((i) => i.kind === 'tool')
    const results = all.items.filter((i): i is Extract<TranscriptItem, { kind: 'result' }> => i.kind === 'result')
    expect(results.map((r) => r.toolId)).toEqual(tools.map((t) => (t as { toolId: string }).toolId))
    expect(results.filter((r) => r.error)).toHaveLength(8)
    const collected: TranscriptItem[] = []
    let page = await codexTranscriptPage(file, 'th', { limit: 7 })
    expect(page.end).toBe(all.end)
    collected.unshift(...page.items)
    let guard = 0
    while (!page.atStart && guard++ < 200) {
      page = await codexTranscriptPage(file, 'th', { before: page.start, limit: 7 })
      collected.unshift(...page.items)
    }
    expect(ids(collected)).toEqual(ids(all.items))
    expect(new Set(ids(collected)).size).toBe(collected.length)
  })

  it('linha ainda sendo escrita fica de fora e chega pelo after quando termina', async () => {
    const partial = JSON.stringify(agentMessage('novo', 'quase lá'))
    writeFileSync(file, rollout(3).join('\n') + '\n' + partial.slice(0, 40))
    const first = await codexTranscriptPage(file, 'th', { limit: 50 })
    expect(first.items.some((i) => i.kind === 'assistant' && i.text === 'quase lá')).toBe(false)
    expect(await codexTranscriptPage(file, 'th', { after: first.end, limit: 50 })).toMatchObject({ items: [], end: first.end })
    appendFileSync(file, partial.slice(40) + '\n')
    const next = await codexTranscriptPage(file, 'th', { after: first.end, limit: 50 })
    expect(next.items).toMatchObject([{ kind: 'assistant', text: 'quase lá', id: String(first.end) }])
    expect(await codexTranscriptPage(file, 'th', { after: next.end, limit: 50 })).toMatchObject({ items: [] })
  })

  it('cursor fora de começo de linha ou além do fim (arquivo reescrito) pede para recomeçar', async () => {
    writeFileSync(file, rollout(3).join('\n') + '\n')
    const page = await codexTranscriptPage(file, 'th', { limit: 2 })
    expect(await codexTranscriptPage(file, 'th', { before: page.start + 1, limit: 2 })).toMatchObject({ reset: true, items: [] })
    expect(await codexTranscriptPage(file, 'th', { after: page.end - 1, limit: 2 })).toMatchObject({ reset: true })
    truncateSync(file, 10)
    expect(await codexTranscriptPage(file, 'th', { after: page.end, limit: 2 })).toMatchObject({ reset: true })
  })

  it('sem rollout ainda: página vazia; rollout que sumiu com cursor adiantado: recomeça', async () => {
    const missing = join(dir, 'nada.jsonl')
    expect(await codexTranscriptPage(missing, 'th', { limit: 10 })).toMatchObject({ items: [], atStart: true, start: 0, end: 0 })
    expect(await codexTranscriptPage(null, 'th', { limit: 10 })).toMatchObject({ items: [], atStart: true })
    expect((await codexTranscriptPage(missing, 'th', { after: 0, limit: 10 })).reset).toBeUndefined()
    expect(await codexTranscriptPage(missing, 'th', { after: 500, limit: 10 })).toMatchObject({ reset: true })
    expect(await codexTranscriptPage(null, 'th', { after: 500, limit: 10 })).toMatchObject({ reset: true })
  })

  it('status vem do turn_context mais recente, mesmo fora da primeira página; página antiga não traz status', async () => {
    writeFileSync(file, rollout(6, (n) => `e${n}`).join('\n') + '\n')
    const latest = await codexTranscriptPage(file, 'th', { limit: 12 })
    expect(latest.atStart).toBe(false)
    expect(latest.status).toEqual({ model: 'gpt-x', effort: 'e5', mode: 'never · danger-full-access' })
    // Uma página de um item só não alcança o turn_context do turno atual.
    const tiny = await codexTranscriptPage(file, 'th', { limit: 1 })
    expect(tiny.items.map((i) => i.kind)).toEqual(['turn'])
    expect(tiny.status?.effort).toBe('e5')
    const older = await codexTranscriptPage(file, 'th', { before: latest.start, limit: 5 })
    expect(older.items.length).toBeGreaterThan(0)
    expect(older.status).toBeUndefined()
    const end = latest.end
    appendFileSync(file, [taskStarted(), turnContext('xhigh', { granular: { sandbox_approval: false } }, 'workspace-write'), userMessage('u9', 'mais')].map((l) => JSON.stringify(l)).join('\n') + '\n')
    expect((await codexTranscriptPage(file, 'th', { after: end, limit: 30 })).status).toEqual({ model: 'gpt-x', effort: 'xhigh', mode: 'granular · workspace-write' })
    const quiet = await codexTranscriptPage(file, 'th', { after: (await codexTranscriptPage(file, 'th', { limit: 1 })).end, limit: 30 })
    expect(quiet.status).toBeUndefined()
  })
})
