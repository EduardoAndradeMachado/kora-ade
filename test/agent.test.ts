import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startupCommand } from '../src/shared/agent'
import { AgentDetector, claudeStateForPid } from '../src/main/agent-detect'
import { fileHolders, listProcesses, withCreationTime } from '../src/main/processes'
import { Terminals } from '../src/main/terminals'

// Formato real capturado de ~/.claude/sessions/3576.json (Claude Code 2.1.281).
const claudePidFile = (pid: number, sessionId: string, status = 'idle'): string =>
  JSON.stringify({
    pid,
    sessionId,
    cwd: 'C:\\Users\\voce\\Documents\\projetos\\exemplo',
    startedAt: 1790253292461,
    procStart: '134347268915295205',
    version: '2.1.281',
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'exemplo-75',
    nameSource: 'derived',
    status
  })

describe('comando de abertura da aba', () => {
  it('monta claude/codex novo e retomada', () => {
    const id = '01a0d12c-6ac8-7591-8c6f-3a67bf0c629e'
    expect(startupCommand({ kind: 'claude', mode: 'new', sessionId: id })).toBe(`claude --session-id ${id}`)
    expect(startupCommand({ kind: 'claude', mode: 'resume', sessionId: id })).toBe(`claude --resume ${id}`)
    expect(startupCommand({ kind: 'codex', mode: 'resume', sessionId: id })).toBe(`codex resume ${id}`)
    expect(startupCommand({ kind: 'codex', mode: 'new' })).toBe('codex')
  })

  it('recusa ID que não é UUID (vai para a linha de comando do PowerShell)', () => {
    expect(() => startupCommand({ kind: 'claude', mode: 'resume', sessionId: 'x; Remove-Item C:\\' })).toThrow(/inválido/)
  })
})

describe('sessão do Claude pelo pid', () => {
  it('lê o sessionId, o nome e o estado do arquivo do pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-claude-'))
    const sessionId = randomUUID()
    writeFileSync(join(dir, '3576.json'), claudePidFile(3576, sessionId), 'utf8')
    expect(claudeStateForPid(dir, 3576)).toEqual({ agent: { kind: 'claude', sessionId, name: 'exemplo-75' }, activity: 'waiting' })
    writeFileSync(join(dir, '3576.json'), claudePidFile(3576, sessionId, 'busy'), 'utf8')
    expect(claudeStateForPid(dir, 3576)?.activity).toBe('working')
  })

  it('ignora arquivo de outro pid ou sem sessão válida', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-claude-'))
    writeFileSync(join(dir, '10.json'), claudePidFile(11, randomUUID()), 'utf8')
    writeFileSync(join(dir, '12.json'), claudePidFile(12, 'nao-e-uuid'), 'utf8')
    expect(claudeStateForPid(dir, 10)).toBeNull()
    expect(claudeStateForPid(dir, 12)).toBeNull()
    expect(claudeStateForPid(dir, 99)).toBeNull()
  })
})

describe('AgentDetector de ponta a ponta (pty real + árvore de processos real + Restart Manager real)', () => {
  const terminals = new Terminals({ onData: () => {}, onExit: () => {} })
  afterEach(() => terminals.killAll())

  // Roda um node dentro da aba que grava o próprio pid (e opcionalmente mantém um arquivo aberto).
  async function fakeAgentIn(tabId: string, holdFile?: string): Promise<number> {
    const markerDir = mkdtempSync(join(tmpdir(), 'kora-marker-'))
    const marker = join(markerDir, 'pid.txt')
    const hold = holdFile ? `require('fs').openSync(${JSON.stringify(holdFile)}, 'r+');` : ''
    const script = join(markerDir, 'agent.js')
    writeFileSync(
      script,
      `${hold} require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 20000)`
    )
    terminals.write(tabId, `node "${script}"\r`)
    const start = Date.now()
    while (!existsSync(marker)) {
      if (Date.now() - start > 15000) throw new Error('processo falso não subiu')
      await new Promise((r) => setTimeout(r, 100))
    }
    return Number(readFileSync(marker, 'utf8'))
  }

  it('liga cada aba à sessão certa: Claude pelo arquivo do pid, Codex por quem segura o lock', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'kora-sessions-'))
    const locksDir = mkdtempSync(join(tmpdir(), 'kora-locks-'))
    const threadId = randomUUID()
    const otherThread = randomUUID()
    writeFileSync(join(locksDir, `${threadId}.lock`), '')
    // Lock de um Codex rodando fora do Kora: não pode ser atribuído a nenhuma aba.
    writeFileSync(join(locksDir, `${otherThread}.lock`), '')

    const tabClaude = randomUUID()
    const tabCodex = randomUUID()
    const tabShell = randomUUID()
    terminals.spawn(tabClaude, tmpdir(), 120, 30)
    terminals.spawn(tabCodex, tmpdir(), 120, 30)
    terminals.spawn(tabShell, tmpdir(), 120, 30)

    const claudePid = await fakeAgentIn(tabClaude)
    const sessionId = randomUUID()
    writeFileSync(join(sessionsDir, `${claudePid}.json`), claudePidFile(claudePid, sessionId), 'utf8')
    await fakeAgentIn(tabCodex, join(locksDir, `${threadId}.lock`))
    const rollout = join(mkdtempSync(join(tmpdir(), 'kora-rollout-')), `rollout-2026-09-24T10-00-00-${threadId}.jsonl`)
    writeFileSync(rollout, '{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}\n', 'utf8')

    const detector = new AgentDetector({
      claudeSessionsDir: sessionsDir,
      codexLocksDir: locksDir,
      listProcesses,
      creationTime: (p) => withCreationTime(p).createdMs,
      lockHolders: fileHolders,
      codexRollout: (id) => (id === threadId ? rollout : null)
    })
    const found = detector.detect(terminals.pids())

    expect(found.get(tabClaude)).toEqual({ agent: { kind: 'claude', sessionId, name: 'exemplo-75' }, activity: 'waiting' })
    expect(found.get(tabCodex)).toEqual({ agent: { kind: 'codex', sessionId: threadId }, activity: 'working' })
    expect(found.has(tabShell)).toBe(false)
  })
})
