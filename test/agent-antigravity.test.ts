import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { startupCommand, type AgentActivity } from '../src/shared/agent'
import { AGY_SCAN_GAP_MS, AgentDetector, type AntigravitySources } from '../src/main/agent-detect'
import { agyPresenceLocks, readAgyConversation } from '../src/main/antigravity-conversations'
import { filesHolders, listProcesses, withCreationTime, type ProcInfo } from '../src/main/processes'
import { Terminals } from '../src/main/terminals'

describe('comando de abertura da aba do agy', () => {
  it('abre conversa nova sem ID e retoma pelo --conversation', () => {
    const id = '701c908d-4e09-4135-b507-8a69ff2159d6'
    expect(startupCommand({ kind: 'antigravity', mode: 'new' })).toBe('agy')
    expect(startupCommand({ kind: 'antigravity', mode: 'resume', sessionId: id })).toBe(`agy --conversation ${id}`)
    expect(() => startupCommand({ kind: 'antigravity', mode: 'resume', sessionId: 'x; Remove-Item C:\\' })).toThrow(/inválido/)
  })
})

// Árvore real de uma aba aberta pelo "+": PowerShell, o agy.cmd do usuário (cmd.exe) e o agy.exe.
const SHELL = 100
const shell: ProcInfo = { pid: SHELL, ppid: 1, name: 'powershell.exe', createdMs: null }
const cmd: ProcInfo = { pid: 150, ppid: SHELL, name: 'cmd.exe', createdMs: null }
const agy: ProcInfo = { pid: 200, ppid: 150, name: 'agy.exe', createdMs: null }
const TAB = 'aba-agy'
const AGY_STARTED = Date.parse('2026-11-16T12:00:00Z')

interface Lock {
  id: string
  birthMs: number
}

function fakeAgy(opts: {
  locks: Lock[]
  held?: Map<string, number[]>
  conversations?: Map<string, { subagent: boolean; activity: AgentActivity | null }>
  claudeSessionsDir?: string
}) {
  const held = opts.held ?? new Map<string, number[]>()
  const file = (id: string): string => `presence/${id}.lock`
  const calls: string[][] = []
  let clock = AGY_STARTED + 10_000
  let procs: ProcInfo[] = []
  const sources: AntigravitySources = {
    presenceLocks: () => opts.locks.map((l) => ({ ...l, file: file(l.id) })),
    conversation: (id) => opts.conversations?.get(id) ?? { subagent: false, activity: 'waiting' },
    holders: (files) => {
      calls.push(files)
      return [...new Set(files.flatMap((f) => held.get(f.slice('presence/'.length, -'.lock'.length)) ?? []))]
    }
  }
  const detector = new AgentDetector({
    claudeSessionsDir: opts.claudeSessionsDir ?? mkdtempSync(join(tmpdir(), 'kora-sessions-')),
    codexLocksDir: mkdtempSync(join(tmpdir(), 'kora-locks-')),
    listProcesses: () => procs,
    creationTime: (p) => (p.pid === agy.pid ? AGY_STARTED : 0),
    lockHolders: () => [],
    codexRollout: () => null,
    antigravity: sources,
    now: () => clock
  })
  return {
    calls,
    held,
    advance: (ms: number) => (clock += ms),
    detect: (list: ProcInfo[]) => {
      procs = list
      return detector.detect(new Map([[TAB, SHELL]])).get(TAB)
    }
  }
}

const oldLocks = (n: number): Lock[] => Array.from({ length: n }, (_, i) => ({ id: randomUUID(), birthMs: AGY_STARTED - (n - i) * 86_400_000 }))

describe('AgentDetector: agy', () => {
  it('conversa nova: o lock nascido depois do processo liga a aba, com a atividade da conversa', () => {
    const fresh = { id: randomUUID(), birthMs: AGY_STARTED + 2_000 }
    const run = fakeAgy({
      locks: [...oldLocks(30), fresh],
      held: new Map([[fresh.id, [agy.pid]]]),
      conversations: new Map([[fresh.id, { subagent: false, activity: 'working' }]])
    })
    expect(run.detect([shell, cmd, agy])).toEqual({ agent: { kind: 'antigravity', sessionId: fresh.id }, activity: 'working' })
    expect(run.calls, 'só o lock novo é consultado').toEqual([[`presence/${fresh.id}.lock`]])
  })

  it('conversa antiga retomada: a busca em grupo acha o lock entre dezenas, e depois basta conferir o mesmo', () => {
    const locks = oldLocks(37)
    const resumed = locks[23]!
    const run = fakeAgy({ locks, held: new Map([[resumed.id, [agy.pid]]]) })
    expect(run.detect([shell, cmd, agy])).toMatchObject({ agent: { kind: 'antigravity', sessionId: resumed.id } })
    expect(run.calls.length, 'busca binária, não uma consulta por arquivo').toBeLessThanOrEqual(8)
    run.calls.length = 0
    expect(run.detect([shell, cmd, agy])).toMatchObject({ agent: { kind: 'antigravity', sessionId: resumed.id } })
    expect(run.calls).toEqual([[`presence/${resumed.id}.lock`]])
  })

  it('/resume para outra conversa dentro do agy: o lock antigo solto faz procurar de novo', () => {
    const locks = oldLocks(10)
    const run = fakeAgy({ locks, held: new Map([[locks[2]!.id, [agy.pid]]]) })
    expect(run.detect([shell, cmd, agy])).toMatchObject({ agent: { sessionId: locks[2]!.id } })
    run.held.clear()
    run.held.set(locks[7]!.id, [agy.pid])
    expect(run.detect([shell, cmd, agy])).toMatchObject({ agent: { sessionId: locks[7]!.id } })
  })

  it('sem agy na aba nenhuma consulta de lock é feita, por mais locks que existam', () => {
    const run = fakeAgy({ locks: oldLocks(50) })
    expect(run.detect([shell, { pid: 300, ppid: SHELL, name: 'node.exe', createdMs: null }])).toBeUndefined()
    expect(run.calls).toEqual([])
  })

  it('agy ainda sem lock: busca completa no máximo uma vez a cada intervalo', () => {
    const run = fakeAgy({ locks: oldLocks(20) })
    expect(run.detect([shell, cmd, agy])).toBeUndefined()
    const afterFirst = run.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    run.advance(AGY_SCAN_GAP_MS - 1)
    run.detect([shell, cmd, agy])
    expect(run.calls.length).toBe(afterFirst)
    run.advance(1)
    run.detect([shell, cmd, agy])
    expect(run.calls.length).toBeGreaterThan(afterFirst)
  })

  it('subagente do agy não toma a aba, mesmo se o lock dele aparecer como do processo', () => {
    const sub = { id: randomUUID(), birthMs: AGY_STARTED + 3_000 }
    const run = fakeAgy({
      locks: [sub],
      held: new Map([[sub.id, [agy.pid]]]),
      conversations: new Map([[sub.id, { subagent: true, activity: 'working' }]])
    })
    expect(run.detect([shell, cmd, agy])).toBeUndefined()
  })

  it('Claude ou Codex que o agy roda como ferramenta não tomam a aba do agy, nem antes do lock dele existir', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'kora-sessions-'))
    const claudeSession = randomUUID()
    writeFileSync(join(sessionsDir, '500.json'), JSON.stringify({ pid: 500, sessionId: claudeSession, status: 'busy' }))
    const run = fakeAgy({ locks: [], claudeSessionsDir: sessionsDir })
    const claudeAlone: ProcInfo = { pid: 500, ppid: SHELL, name: 'claude.exe', createdMs: null }
    expect(run.detect([shell, claudeAlone]), 'o mesmo Claude direto na aba é detectado').toMatchObject({
      agent: { kind: 'claude', sessionId: claudeSession }
    })
    const claudeChild: ProcInfo = { pid: 500, ppid: agy.pid, name: 'claude.exe', createdMs: null }
    expect(run.detect([shell, cmd, agy, claudeChild])).toBeUndefined()
  })

  it('agy rodado pelo Claude (agy -p numa ferramenta) não troca a aba do Claude nem dispara a busca de locks', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'kora-sessions-'))
    const claudeSession = randomUUID()
    const claude: ProcInfo = { pid: 400, ppid: SHELL, name: 'claude.exe', createdMs: null }
    writeFileSync(join(sessionsDir, '400.json'), JSON.stringify({ pid: 400, sessionId: claudeSession, status: 'idle' }))
    const fresh = { id: randomUUID(), birthMs: AGY_STARTED + 1_000 }
    const calls: string[][] = []
    let procs: ProcInfo[] = []
    const detector = new AgentDetector({
      claudeSessionsDir: sessionsDir,
      codexLocksDir: mkdtempSync(join(tmpdir(), 'kora-locks-')),
      listProcesses: () => procs,
      creationTime: () => AGY_STARTED,
      lockHolders: () => [],
      codexRollout: () => null,
      antigravity: {
        presenceLocks: () => [{ ...fresh, file: 'f' }],
        conversation: () => ({ subagent: false, activity: 'working' }),
        holders: (files) => (calls.push(files), [600])
      }
    })
    procs = [shell, claude, { pid: 600, ppid: claude.pid, name: 'agy.exe', createdMs: null }]
    expect(detector.detect(new Map([[TAB, SHELL]])).get(TAB)).toMatchObject({ agent: { kind: 'claude', sessionId: claudeSession } })
    expect(calls).toEqual([])
  })
})

describe('AgentDetector: agy de ponta a ponta (pty real + árvore real + Restart Manager real + SQLite real)', () => {
  const terminals = new Terminals({ onData: () => {}, onExit: () => {} })
  afterEach(() => terminals.killAll())

  // O próprio node com o nome agy.exe: o detector reconhece o agy pelo nome do executável.
  function agyExecutable(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kora-agy-bin-'))
    const exe = join(dir, 'agy.exe')
    try {
      linkSync(process.execPath, exe)
    } catch {
      copyFileSync(process.execPath, exe)
    }
    return exe
  }

  function conversationDb(root: string, id: string, parentId: string | null, steps: [number, number][]): void {
    const field = (n: number, value: string): Buffer => {
      const bytes = Buffer.from(value, 'utf8')
      return Buffer.concat([Buffer.from([(n << 3) | 2, bytes.length]), bytes])
    }
    const db = new DatabaseSync(join(root, 'conversations', `${id}.db`))
    db.exec('create table trajectory_metadata_blob (id text, data blob)')
    db.exec('create table steps (idx integer, step_type integer, status integer, step_payload blob)')
    const meta = Buffer.concat([field(7, 'file:///C:/Projetos/exemplo'), ...(parentId ? [field(5, parentId)] : [])])
    db.prepare('insert into trajectory_metadata_blob values (?, ?)').run('m', meta)
    steps.forEach(([type, status], i) => db.prepare('insert into steps values (?, ?, ?, ?)').run(i, type, status, null))
    db.close()
  }

  it('liga a aba à conversa cujo lock o agy segura; o subagente do mesmo processo fica de fora', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-agy-'))
    mkdirSync(join(root, 'conversations'))
    mkdirSync(join(root, 'presence'))
    const main = randomUUID()
    const sub = randomUUID()
    const other = randomUUID()
    // Turno em andamento: pedido e uma ferramenta rodando.
    conversationDb(root, main, null, [[14, 3], [132, 2]])
    conversationDb(root, sub, main, [[14, 3]])
    conversationDb(root, other, null, [[14, 3]])
    for (const id of [other, main, sub]) writeFileSync(join(root, 'presence', `${id}.lock`), '')

    const markers = mkdtempSync(join(tmpdir(), 'kora-marker-'))
    const marker = join(markers, 'pid.txt')
    const script = join(markers, 'agy.js')
    const lock = (id: string): string => JSON.stringify(join(root, 'presence', `${id}.lock`))
    writeFileSync(
      script,
      `require('fs').openSync(${lock(main)}, 'r+'); require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 20000)`
    )
    const tab = randomUUID()
    const quiet = randomUUID()
    terminals.spawn(tab, tmpdir(), 120, 30)
    terminals.spawn(quiet, tmpdir(), 120, 30)
    terminals.write(tab, `& "${agyExecutable()}" "${script}"\r`)
    const start = Date.now()
    while (!existsSync(marker)) {
      if (Date.now() - start > 15000) throw new Error('agy falso não subiu')
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(Number(readFileSync(marker, 'utf8'))).toBeGreaterThan(0)

    const sources = (pretendOld: boolean): AntigravitySources => ({
      // Locks "antigos" forçam a busca em grupo pelo Restart Manager em vez do atalho do lock recém-criado.
      presenceLocks: () => agyPresenceLocks(root).map((l) => (pretendOld ? { ...l, birthMs: 0 } : l)),
      conversation: (id) => readAgyConversation(root, id),
      holders: filesHolders
    })
    for (const pretendOld of [false, true]) {
      const detector = new AgentDetector({
        claudeSessionsDir: mkdtempSync(join(tmpdir(), 'kora-sessions-')),
        codexLocksDir: mkdtempSync(join(tmpdir(), 'kora-locks-')),
        listProcesses,
        creationTime: (p) => withCreationTime(p).createdMs,
        lockHolders: () => [],
        codexRollout: () => null,
        antigravity: sources(pretendOld)
      })
      const found = detector.detect(terminals.pids())
      expect(found.get(tab), pretendOld ? 'pela busca em grupo' : 'pelo lock recém-criado').toEqual({
        agent: { kind: 'antigravity', sessionId: main },
        activity: 'working'
      })
      expect(found.has(quiet)).toBe(false)
    }
  })
})
