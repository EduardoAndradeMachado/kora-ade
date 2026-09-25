import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startupCommand } from '../src/shared/agent'
import { AgentDetector, claudeStateForPid, codexMetaIsSubagent, UNREADABLE } from '../src/main/agent-detect'
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
    expect(startupCommand({ kind: 'codex', mode: 'resume', sessionId: id })).toBe(`codex resume ${id} --no-daemon`)
    expect(startupCommand({ kind: 'codex', mode: 'new' })).toBe('codex --no-daemon')
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
    expect(claudeStateForPid(dir, 3576)).toMatchObject({ activity: 'working' })
  })

  it('busy com o turno encerrado no transcript (subagente em segundo plano) é esperando você', () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-claude-root-'))
    const dir = join(root, 'sessions')
    const projectDir = join(root, 'projects', 'C--Users-voce-Documents-projetos-exemplo')
    mkdirSync(dir)
    mkdirSync(projectDir, { recursive: true })
    const sessionId = randomUUID()
    writeFileSync(join(dir, '3576.json'), claudePidFile(3576, sessionId, 'busy'), 'utf8')
    expect(claudeStateForPid(dir, 3576), 'sem transcript: vale o status').toMatchObject({ activity: 'working' })

    const transcript = join(projectDir, `${sessionId}.jsonl`)
    const entry = (data: object): void => appendFileSync(transcript, JSON.stringify(data) + '\n', 'utf8')
    entry({ type: 'user', message: { role: 'user', content: 'rode o subagente' } })
    expect(claudeStateForPid(dir, 3576)).toMatchObject({ activity: 'working' })
    entry({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } })
    entry({ type: 'system', subtype: 'turn_duration', durationMs: 5000, pendingBackgroundAgentCount: 1 })
    entry({ type: 'queue-operation', operation: 'enqueue' })
    expect(claudeStateForPid(dir, 3576)).toMatchObject({ activity: 'waiting' })

    // O aviso do subagente chega como mensagem e abre um turno novo.
    entry({ type: 'user', message: { role: 'user', content: '<task-notification>' } })
    expect(claudeStateForPid(dir, 3576)).toMatchObject({ activity: 'working' })
  })

  it('ignora arquivo de outro pid ou sem sessão válida', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-claude-'))
    writeFileSync(join(dir, '10.json'), claudePidFile(11, randomUUID()), 'utf8')
    writeFileSync(join(dir, '12.json'), claudePidFile(12, 'nao-e-uuid'), 'utf8')
    expect(claudeStateForPid(dir, 10)).toBeNull()
    expect(claudeStateForPid(dir, 12)).toBeNull()
    expect(claudeStateForPid(dir, 99)).toBeNull()
  })

  it('arquivo pego no meio da reescrita é "sem leitura agora", não "sem Claude"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-claude-'))
    writeFileSync(join(dir, '3576.json'), claudePidFile(3576, randomUUID()).slice(0, 40), 'utf8')
    expect(claudeStateForPid(dir, 3576)).toBe(UNREADABLE)
    writeFileSync(join(dir, '3576.json'), '', 'utf8')
    expect(claudeStateForPid(dir, 3576)).toBe(UNREADABLE)
  })
})

describe('AgentDetector de ponta a ponta (pty real + árvore de processos real + Restart Manager real)', () => {
  const terminals = new Terminals({ onData: () => {}, onExit: () => {} })
  afterEach(() => terminals.killAll())

  // Roda um node dentro da aba que grava o próprio pid (e opcionalmente mantém um arquivo aberto).
  async function fakeAgentIn(tabId: string, ...holdFiles: string[]): Promise<number> {
    const markerDir = mkdtempSync(join(tmpdir(), 'kora-marker-'))
    const marker = join(markerDir, 'pid.txt')
    const hold = holdFiles.map((f) => `require('fs').openSync(${JSON.stringify(f)}, 'r+');`).join(' ')
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

  it('Codex com subagente: o mesmo processo segura os dois locks e a aba fica na conversa principal', async () => {
    const locksDir = mkdtempSync(join(tmpdir(), 'kora-locks-'))
    const rolloutsDir = mkdtempSync(join(tmpdir(), 'kora-rollout-'))
    const mainThread = randomUUID()
    const subThread = randomUUID()
    // Primeira linha no formato real do Codex 0.157 (sem os ids de conta); base_instructions deixa a linha com ~22 KB.
    const meta = (id: string, source: unknown): string =>
      JSON.stringify({
        timestamp: '2026-09-25T14:32:35.631Z',
        ordinal: 0,
        type: 'session_meta',
        payload: {
          id,
          cwd: 'C:\\Users\\voce\\Documents\\projetos\\exemplo',
          originator: 'codex-tui',
          cli_version: '0.157.0',
          source,
          base_instructions: { text: 'x'.repeat(22_000) }
        }
      }) + '\n'
    const rollouts = new Map<string, string>()
    const rollout = (id: string, source: unknown, events: string[]): void => {
      const file = join(rolloutsDir, `rollout-2026-09-25T11-32-17-${id}.jsonl`)
      writeFileSync(file, meta(id, source) + events.map((e) => `{"type":"event_msg","payload":{"type":"${e}"}}\n`).join(''), 'utf8')
      rollouts.set(id, file)
    }
    rollout(mainThread, 'cli', ['task_started', 'task_complete'])
    rollout(
      subThread,
      { subagent: { thread_spawn: { parent_thread_id: mainThread, depth: 1, agent_path: '/root/ping', agent_nickname: 'Linnaeus', agent_role: null } } },
      ['task_started']
    )
    writeFileSync(join(locksDir, `${mainThread}.lock`), '')
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(join(locksDir, `${subThread}.lock`), '')

    const tab = randomUUID()
    terminals.spawn(tab, tmpdir(), 120, 30)
    await fakeAgentIn(tab, join(locksDir, `${mainThread}.lock`), join(locksDir, `${subThread}.lock`))

    const detector = new AgentDetector({
      claudeSessionsDir: mkdtempSync(join(tmpdir(), 'kora-sessions-')),
      codexLocksDir: locksDir,
      listProcesses,
      creationTime: (p) => withCreationTime(p).createdMs,
      lockHolders: fileHolders,
      codexRollout: (id) => rollouts.get(id) ?? null
    })
    expect(detector.detect(terminals.pids()).get(tab), 'subagente trabalhando não prende a aba nem o estado').toEqual({
      agent: { kind: 'codex', sessionId: mainThread },
      activity: 'waiting'
    })

    // Subagente recém-criado cujo rollout ainda não foi achado: a principal, já conhecida, continua na aba.
    const early = new AgentDetector({
      claudeSessionsDir: mkdtempSync(join(tmpdir(), 'kora-sessions-')),
      codexLocksDir: locksDir,
      listProcesses,
      creationTime: (p) => withCreationTime(p).createdMs,
      lockHolders: fileHolders,
      codexRollout: (id) => (id === mainThread ? rollouts.get(id)! : null)
    })
    expect(early.detect(terminals.pids()).get(tab)).toMatchObject({ agent: { kind: 'codex', sessionId: mainThread } })

    // Rollout da principal ainda não achado e o do subagente já lido: o subagente continua fora.
    const onlySub = new AgentDetector({
      claudeSessionsDir: mkdtempSync(join(tmpdir(), 'kora-sessions-')),
      codexLocksDir: locksDir,
      listProcesses,
      creationTime: (p) => withCreationTime(p).createdMs,
      lockHolders: fileHolders,
      codexRollout: (id) => (id === subThread ? rollouts.get(id)! : null)
    })
    expect(onlySub.detect(terminals.pids()).get(tab)).toMatchObject({ agent: { kind: 'codex', sessionId: mainThread } })
  })

  it('primeira linha do rollout: subagente, principal ou ainda sem leitura', () => {
    const line = (source: unknown): string => JSON.stringify({ type: 'session_meta', payload: { id: 'x', source } }) + '\n'
    const sub = line({ subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } })
    expect(codexMetaIsSubagent(sub)).toBe(true)
    expect(codexMetaIsSubagent(line('cli'))).toBe(false)
    expect(codexMetaIsSubagent(line('vscode'))).toBe(false)
    expect(codexMetaIsSubagent(sub.slice(0, 40)), 'linha ainda sendo gravada').toBeNull()
    expect(codexMetaIsSubagent('{"type":"event_msg","payload":{}}\n')).toBeNull()
    expect(codexMetaIsSubagent('')).toBeNull()
  })
})
