import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeActivity, codexActivity, readTail } from '../src/main/agent-activity'

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
  it('busy é trabalhando; waiting e idle são esperando você; o resto fica sem indicador', () => {
    expect(claudeActivity('busy')).toBe('working')
    expect(claudeActivity('waiting')).toBe('waiting')
    expect(claudeActivity('idle')).toBe('waiting')
    expect(claudeActivity('shell')).toBeNull()
    expect(claudeActivity(undefined)).toBeNull()
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
