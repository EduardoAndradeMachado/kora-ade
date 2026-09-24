import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  killOrder,
  ProcessRegistry,
  survivorTree,
  type ProcessIdentity,
  type RegisteredProcess
} from '../src/main/process-registry'
import { listProcesses, withCreationTime, type ProcInfo } from '../src/main/processes'

// Detached porque o libuv põe filhos não-detached num job que os mata junto com o pai: com isso,
// "killTree só no pai" passaria despercebido, já que o filho morreria de carona.
const CHILD = `
const hold = Buffer.alloc(Number(process.env.KORA_TEST_MB || 0) * 1024 * 1024, 1)
process.stdout.write('ready\\n')
setTimeout(() => hold.length, 30000)
`
const PARENT = `
const hold = Buffer.alloc(Number(process.env.KORA_TEST_MB || 0) * 1024 * 1024, 1)
const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(CHILD)}], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
c.stdout.once('data', () => process.stdout.write(c.pid + '\\n'))
setTimeout(() => hold.length, 30000)
`

// Identidade de um Kora que já morreu: o PID existe (é o do vitest), mas o horário de criação não bate.
const DEAD_KORA: ProcessIdentity = { pid: process.pid, createdMs: 1 }

let dir: string
let file: string
const spawned: ProcessIdentity[] = []

function identity(pid: number): ProcessIdentity {
  const createdMs = withCreationTime({ pid, ppid: 0, name: '', createdMs: null }).createdMs
  if (createdMs === null) throw new Error(`processo ${pid} não existe`)
  const id = { pid, createdMs }
  spawned.push(id)
  return id
}

function isAlive(id: ProcessIdentity): boolean {
  const found = listProcesses().find((p) => p.pid === id.pid)
  return found !== undefined && withCreationTime(found).createdMs === id.createdMs
}

async function spawnTree(mb = 0): Promise<{ parent: ProcessIdentity; child: ProcessIdentity }> {
  const proc = spawn(process.execPath, ['-e', PARENT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
    env: { ...process.env, KORA_TEST_MB: String(mb) }
  })
  const parent = identity(proc.pid!)
  const childPid = await new Promise<number>((resolve, reject) => {
    proc.stdout!.once('data', (d) => resolve(Number(String(d).trim())))
    proc.once('exit', (code) => reject(new Error(`pai saiu antes da hora (${code})`)))
  })
  return { parent, child: identity(childPid) }
}

function spawnSleeper(): ProcessIdentity {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: true })
  return identity(child.pid!)
}

const launch = (pid: number, tabId = 'tab-1') => ({
  pid,
  tabId,
  projectId: 'proj-1',
  title: 'Claude',
  agentKind: 'claude' as const
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kora-registry-'))
  file = join(dir, 'processes.json')
})

afterEach(() => {
  for (const id of spawned.splice(0)) {
    if (isAlive(id)) process.kill(id.pid)
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('ProcessRegistry com processos reais', () => {
  it('processo de um Kora morto aparece como sobrevivente, com o filho e a memória somada da árvore', async () => {
    const tree = await spawnTree(100)
    new ProcessRegistry(file, DEAD_KORA).add(launch(tree.parent.pid))

    const survivors = new ProcessRegistry(file).findSurvivors()

    expect(survivors).toHaveLength(1)
    const [s] = survivors
    expect(s!.key).toBe(`${tree.parent.pid}:${tree.parent.createdMs}`)
    expect(s!.entry).toMatchObject({ tabId: 'tab-1', projectId: 'proj-1', title: 'Claude', agentKind: 'claude' })
    expect(s!.processes.map((p) => p.pid).sort()).toEqual([tree.parent.pid, tree.child.pid].sort())
    // Cada processo segura 100 MB escritos; só o pai daria ~130 MB, a árvore passa de 200 MB.
    expect(s!.memoryBytes).toBeGreaterThan(200 * 1024 * 1024)
    expect(s!.memoryBytes).toBeLessThan(1024 * 1024 * 1024)
  })

  it('PID reaproveitado: vivo com horário de criação diferente não é sobrevivente, nem os filhos dele', async () => {
    const real = await spawnTree()
    const reused = await spawnTree()
    new ProcessRegistry(file, DEAD_KORA).add(launch(real.parent.pid))
    // Clona a entrada gravada pelo próprio registro, trocando só o que simula o reaproveitamento.
    const data = JSON.parse(readFileSync(file, 'utf8')) as { processes: RegisteredProcess[] }
    const impostor = { ...data.processes[0]!, pid: reused.parent.pid, createdMs: reused.parent.createdMs - 5000, tabId: 'tab-2' }
    data.processes.push(impostor)
    writeFileSync(file, JSON.stringify(data), 'utf8')

    const registry = new ProcessRegistry(file)
    const survivors = registry.findSurvivors()

    expect(survivors.map((s) => s.entry.tabId)).toEqual(['tab-1'])
    expect(registry.list().map((e) => e.tabId)).toEqual(['tab-1'])
  })

  it('processos do Kora atual e de outro Kora ainda vivo não são sobreviventes', () => {
    const mine = spawnSleeper()
    const otherKora = spawnSleeper()
    const theirs = spawnSleeper()
    new ProcessRegistry(file).add(launch(mine.pid, 'mine'))
    new ProcessRegistry(file, otherKora).add(launch(theirs.pid, 'theirs'))

    const registry = new ProcessRegistry(file)

    expect(registry.findSurvivors()).toEqual([])
    expect(registry.list().map((e) => e.tabId).sort()).toEqual(['mine', 'theirs'])
  })

  it('killTree encerra filho e pai e limpa o registro', async () => {
    const tree = await spawnTree()
    new ProcessRegistry(file, DEAD_KORA).add(launch(tree.parent.pid))
    const registry = new ProcessRegistry(file)
    const [survivor] = registry.findSurvivors()

    const result = registry.killTree(survivor!)

    expect(result).toEqual({ killed: 2, gone: 0, failed: 0 })
    expect(isAlive(tree.child)).toBe(false)
    expect(isAlive(tree.parent)).toBe(false)
    expect(new ProcessRegistry(file).list()).toEqual([])
  })

  it('killTree não encerra um PID que agora é de outro programa', async () => {
    const tree = await spawnTree()
    const stranger = spawnSleeper()
    new ProcessRegistry(file, DEAD_KORA).add(launch(tree.parent.pid))
    const registry = new ProcessRegistry(file)
    const [survivor] = registry.findSurvivors()
    // Sobrevivente listado antes: um filho que já saiu teve o PID reaproveitado por outro programa.
    const stale = {
      ...survivor!,
      processes: [...survivor!.processes, { ...stranger, ppid: tree.parent.pid, name: 'node.exe', createdMs: stranger.createdMs - 5000, depth: 1 }]
    }

    const result = registry.killTree(stale)

    expect(isAlive(stranger)).toBe(true)
    expect(result).toEqual({ killed: 2, gone: 1, failed: 0 })
  })

  it('manter (forget) tira do registro sem encerrar nada', async () => {
    const tree = await spawnTree()
    new ProcessRegistry(file, DEAD_KORA).add(launch(tree.parent.pid))
    const registry = new ProcessRegistry(file)
    const [survivor] = registry.findSurvivors()

    registry.forget(survivor!)

    expect(new ProcessRegistry(file).findSurvivors()).toEqual([])
    expect(isAlive(tree.parent) && isAlive(tree.child)).toBe(true)
  })

  it('remove(pid) apaga a entrada quando a aba fecha normalmente', () => {
    const sleeper = spawnSleeper()
    const registry = new ProcessRegistry(file)
    expect(registry.add(launch(sleeper.pid))).toBe(true)

    registry.remove(sleeper.pid)

    expect(new ProcessRegistry(file).list()).toEqual([])
  })

  it('add de processo que já saiu não registra', () => {
    expect(new ProcessRegistry(file).add(launch(0x7ffffff0))).toBe(false)
    expect(new ProcessRegistry(file).list()).toEqual([])
  })

  it('registro corrompido não derruba: vira vazio e o original fica em backup', () => {
    const garbage = '{"version":1,"processes":[{"pid":'
    writeFileSync(file, garbage, 'utf8')

    const registry = new ProcessRegistry(file)

    expect(registry.list()).toEqual([])
    expect(registry.findSurvivors()).toEqual([])
    const backup = readdirSync(dir).find((f) => f.includes('.corrupt-'))
    expect(backup).toBeDefined()
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe(garbage)
    const sleeper = spawnSleeper()
    expect(registry.add(launch(sleeper.pid))).toBe(true)
    expect(new ProcessRegistry(file).list()).toHaveLength(1)
  })
})

describe('killOrder', () => {
  it('encerra os mais profundos primeiro e o shell por último', () => {
    const p = (pid: number, depth: number) => ({ pid, ppid: 0, name: '', createdMs: 0, depth })
    expect(killOrder([p(1, 0), p(2, 1), p(3, 2), p(4, 1)]).map((x) => x.pid)).toEqual([3, 2, 4, 1])
  })
})

describe('survivorTree', () => {
  const proc = (pid: number, ppid: number, createdMs: number | null): ProcInfo => ({ pid, ppid, name: `p${pid}`, createdMs })

  it('inclui netos com a profundidade certa', () => {
    const all = [proc(10, 1, 1000), proc(11, 10, 1100), proc(12, 11, 1200)]
    expect(survivorTree({ pid: 10, createdMs: 1000 }, all).map((p) => [p.pid, p.depth])).toEqual([
      [10, 0],
      [11, 1],
      [12, 2]
    ])
  })

  it('ignora processo com ppid apontando para o PID mas nascido antes dele (pai antigo com o mesmo PID)', () => {
    const all = [proc(10, 1, 1000), proc(11, 10, 900)]
    expect(survivorTree({ pid: 10, createdMs: 1000 }, all).map((p) => p.pid)).toEqual([10])
  })

  it('raiz morta com PID reaproveitado: filhos do impostor ficam de fora, órfão legítimo entra', () => {
    const all = [proc(10, 1, 5000), proc(20, 10, 5100), proc(21, 10, 1500)]
    expect(survivorTree({ pid: 10, createdMs: 1000 }, all).map((p) => p.pid)).toEqual([21])
  })
})
