import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeActivity, claudeTurnEnded, codexActivity, readTail } from '../src/main/agent-activity'

// Linhas no formato real do rollout do Codex (capturado de ~/.codex/sessions, set/2026), encurtadas.
const started = '{"timestamp":"2026-09-24T18:59:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}'
const complete =
  '{"timestamp":"2026-09-24T18:59:44.743Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"ok"}}'
const aborted = '{"timestamp":"2026-09-24T19:00:02.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t2"}}'
const tokens = '{"timestamp":"2026-09-24T18:59:30.000Z","type":"event_msg","payload":{"type":"token_count","info":null}}'
// A resposta do agente pode citar o nome do evento no texto; só o evento de verdade conta.
const quoted =
  '{"timestamp":"2026-09-24T18:59:40.000Z","type":"response_item","payload":{"type":"message","content":[{"type":"output_text","text":"o evento \\"task_complete\\" fecha o turno"}]}}'

const lines = (...l: string[]): string => l.join('\n') + '\n'

describe('estado do Claude pelo arquivo do pid', () => {
  it('busy é trabalhando; waiting, idle e shell (parado com comando em segundo plano) são esperando você; o resto fica sem indicador', () => {
    expect(claudeActivity('busy')).toBe('working')
    expect(claudeActivity('shell')).toBe('waiting')
    expect(claudeActivity('waiting')).toBe('waiting')
    expect(claudeActivity('idle')).toBe('waiting')
    expect(claudeActivity('outro')).toBeNull()
    expect(claudeActivity(undefined)).toBeNull()
  })
})

// Linhas no formato real do transcript do Claude Code 2.1.282 (~/.claude/projects/<pasta>/<sessão>.jsonl), encurtadas.
const claudeUser =
  '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"teste o item 2"},"uuid":"u1"}'
const claudeToolUse =
  '{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","name":"Agent"}]},"uuid":"a1"}'
const claudeToolResult =
  '{"parentUuid":"a1","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Async agent launched"}]},"uuid":"u2"}'
const claudeEnd =
  '{"parentUuid":"u2","isSidechain":false,"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"O teste está rodando"}]},"uuid":"a2"}'
const claudeTurnDuration =
  '{"parentUuid":"a2","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":51183,"messageCount":3893,"pendingBackgroundAgentCount":1,"timestamp":"2026-09-25T13:53:25.962Z","uuid":"d5"}'
const claudeQueue = '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-25T13:54:56.000Z"}'
const claudeSnapshot = '{"type":"file-history-snapshot","messageId":"m1","snapshot":{"trackedFileBackups":{}}}'
const claudeStopHook =
  '{"parentUuid":"a2","isSidechain":false,"type":"system","subtype":"stop_hook_summary","hookCount":1,"uuid":"s1"}'
// Aviso do próprio Claude gravado no meio do turno: bateu o limite de uso e ele continua sozinho depois.
const claudeInformational =
  '{"parentUuid":"a1","isSidechain":false,"type":"system","subtype":"informational","content":"Usage limit reached · continuing automatically at 11:30am · esc or type to cancel","isMeta":false,"level":"notice","uuid":"i1"}'
// A resposta pode citar o nome da entrada no texto; só a entrada de verdade conta.
const claudeQuoted =
  '{"parentUuid":"u2","isSidechain":false,"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"text","text":"{\\"type\\":\\"system\\",\\"subtype\\":\\"turn_duration\\"}"}]},"uuid":"a3"}'

describe('fim de turno do Claude pelo transcript', () => {
  it('turno encerrado (turn_duration) com subagente ainda rodando: o Claude espera você', () => {
    expect(claudeTurnEnded(lines(claudeUser, claudeToolUse, claudeToolResult, claudeEnd, claudeTurnDuration))).toBe(true)
  })

  it('entradas que não são conversa depois do fim do turno não reabrem o turno', () => {
    expect(claudeTurnEnded(lines(claudeEnd, claudeStopHook, claudeTurnDuration, claudeQueue, claudeSnapshot))).toBe(true)
  })

  it('mensagem nova depois do fim do turno (seu pedido ou o aviso do subagente) é turno aberto', () => {
    expect(claudeTurnEnded(lines(claudeEnd, claudeTurnDuration, claudeQueue, claudeUser))).toBe(false)
    expect(claudeTurnEnded(lines(claudeTurnDuration, claudeUser, claudeToolUse))).toBe(false)
  })

  it('no meio do turno ainda está trabalhando, mesmo com a resposta citando turn_duration', () => {
    expect(claudeTurnEnded(lines(claudeUser, claudeToolUse, claudeToolResult))).toBe(false)
    expect(claudeTurnEnded(lines(claudeTurnDuration, claudeUser, claudeToolUse, claudeInformational))).toBe(false)
    expect(claudeTurnEnded(lines(claudeTurnDuration, claudeUser, claudeQuoted))).toBe(false)
  })

  it('trecho sem conversa nenhuma (ou com a primeira linha cortada pela leitura do fim) não encerra o turno', () => {
    expect(claudeTurnEnded(lines(claudeQueue, claudeSnapshot))).toBe(false)
    expect(claudeTurnEnded(claudeTurnDuration.slice(20) + '\n' + claudeQueue + '\n')).toBe(false)
    expect(claudeTurnEnded('')).toBe(false)
  })
})

describe('estado do Codex pelo fim do rollout', () => {
  it('turno aberto é trabalhando; fechado ou interrompido é esperando você', () => {
    expect(codexActivity(lines(complete, started, tokens))).toBe('working')
    expect(codexActivity(lines(started, tokens, complete))).toBe('waiting')
    expect(codexActivity(lines(started, aborted))).toBe('waiting')
  })

  it('o nome do evento citado numa mensagem não fecha o turno', () => {
    expect(codexActivity(lines(started, quoted, tokens))).toBe('working')
  })

  it('sem marcador no trecho lido, o turno longo ainda está correndo', () => {
    expect(codexActivity(lines(tokens, tokens))).toBe('working')
  })

  it('lê só o fim do arquivo', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kora-rollout-')), 'rollout.jsonl')
    writeFileSync(file, lines(complete, 'x'.repeat(5000), started))
    expect(codexActivity(readTail(file, 1000))).toBe('working')
    expect(readTail(file, 1000)).toHaveLength(1000)
    expect(codexActivity(readTail(file))).toBe('working')
  })
})
