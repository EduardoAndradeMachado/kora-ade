import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { JOBOBJECT_EXTENDED_LIMIT_INFORMATION, KillOnCloseJob } from '../src/main/job-object'
import { listProcesses, withCreationTime } from '../src/main/processes'

interface Identity {
  pid: number
  createdMs: number
}

// O dono do job precisa ser outro processo: se o vitest fosse o dono, matar o dono mataria o próprio teste.
// Ele importa o job-object.ts real (Node 22.18+ executa .ts removendo os tipos), então o teste mede o código
// que roda no Kora, não uma cópia das chamadas Win32.
// Os processos são detached porque o libuv põe todo filho não-detached num job próprio com
// KILL_ON_JOB_CLOSE: sem isso eles morreriam com o pai mesmo sem o nosso job, e o teste não mediria nada.
// O node-pty não passa pelo libuv, por isso os shells do Kora ficam órfãos.
const OWNER_SCRIPT = `
import { spawn } from 'node:child_process'
const [moduleUrl, mode] = process.argv.slice(2)
const { KillOnCloseJob } = await import(moduleUrl)
const TARGET = \`
process.stdin.once('data', () => {
  const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: true })
  process.stdout.write(String(c.pid) + '\\\\n')
})
setTimeout(() => {}, 30000)
\`
const target = spawn(process.execPath, ['-e', TARGET], { stdio: ['pipe', 'pipe', 'ignore'], detached: true })
const job = mode === 'job' ? new KillOnCloseJob() : null
const assigned = job ? job.assign(target.pid) : false
target.stdout.once('data', (d) => {
  process.stdout.write(JSON.stringify({ target: target.pid, child: Number(String(d).trim()), assigned }) + '\\n')
})
// O filho do atribuído só nasce depois da atribuição: é o caso do claude.exe aberto dentro do PowerShell.
target.stdin.write('go\\n')
setTimeout(() => {}, 30000)
`

const dir = mkdtempSync(join(tmpdir(), 'kora-job-'))
const ownerFile = join(dir, 'owner.mjs')
writeFileSync(ownerFile, OWNER_SCRIPT, 'utf8')
const moduleUrl = new URL('../src/main/job-object.ts', import.meta.url).href

const spawned: Identity[] = []
const jobs: KillOnCloseJob[] = []

function identity(pid: number): Identity {
  const createdMs = withCreationTime({ pid, ppid: 0, name: '', createdMs: null }).createdMs
  if (createdMs === null) throw new Error(`processo ${pid} não existe`)
  const id = { pid, createdMs }
  spawned.push(id)
  return id
}

function isAlive(id: Identity): boolean {
  const found = listProcesses().find((p) => p.pid === id.pid)
  return found !== undefined && withCreationTime(found).createdMs === id.createdMs
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

function spawnSleeper(): Identity {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: true })
  return identity(child.pid!)
}

async function startOwner(mode: 'job' | 'nojob'): Promise<{ owner: Identity; target: Identity; child: Identity; assigned: boolean }> {
  const proc = spawn(process.execPath, [ownerFile, moduleUrl, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  const owner = identity(proc.pid!)
  let stderr = ''
  proc.stderr!.on('data', (d) => (stderr += String(d)))
  const line = await new Promise<string>((resolve, reject) => {
    proc.stdout!.once('data', (d) => resolve(String(d)))
    proc.once('exit', (code) => reject(new Error(`dono saiu (${code}): ${stderr}`)))
  })
  const msg = JSON.parse(line) as { target: number; child: number; assigned: boolean }
  return { owner, target: identity(msg.target), child: identity(msg.child), assigned: msg.assigned }
}

afterEach(() => {
  for (const job of jobs.splice(0)) job.close()
  for (const id of spawned.splice(0)) {
    if (!isAlive(id)) continue
    try {
      process.kill(id.pid)
    } catch (err) {
      // Pode morrer entre a checagem e o kill (o job fechando leva a árvore junto): já é o que se queria.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    }
  }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('KillOnCloseJob', () => {
  it.runIf(process.arch === 'x64')('struct estendida tem o layout do x64 (padding depois de LimitFlags)', () => {
    expect(koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)).toBe(144)
    expect(koffi.offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, 'IoInfo')).toBe(64)
  })

  it('dono morto à força leva junto o processo atribuído e o filho criado depois', async () => {
    const { owner, target, child, assigned } = await startOwner('job')
    expect(assigned).toBe(true)
    expect(isAlive(target) && isAlive(child)).toBe(true)

    process.kill(owner.pid)

    expect(await waitFor(() => !isAlive(target) && !isAlive(child), 5000)).toBe(true)
  })

  it('controle: sem job, matar o dono deixa o outro processo e o filho vivos', async () => {
    const { owner, target, child } = await startOwner('nojob')

    process.kill(owner.pid)
    await waitFor(() => !isAlive(owner), 5000)
    await new Promise((r) => setTimeout(r, 1500))

    expect(isAlive(target)).toBe(true)
    expect(isAlive(child)).toBe(true)
  })

  it('close() encerra o que está no job', async () => {
    const job = new KillOnCloseJob()
    jobs.push(job)
    const sleeper = spawnSleeper()
    expect(job.assign(sleeper.pid)).toBe(true)

    job.close()

    expect(await waitFor(() => !isAlive(sleeper), 5000)).toBe(true)
  })

  it('falhas viram false sem lançar: pid inexistente, job fechado, processo em job de outra hierarquia', () => {
    const a = new KillOnCloseJob()
    const b = new KillOnCloseJob()
    jobs.push(a, b)
    const p = spawnSleeper()
    const q = spawnSleeper()
    expect(a.assign(p.pid)).toBe(true)
    expect(b.assign(q.pid)).toBe(true)

    // b já tem processo e não está na cadeia de jobs de p: o Windows recusa o aninhamento.
    expect(b.assign(p.pid)).toBe(false)
    expect(a.assign(0)).toBe(false)
    expect(a.assign(0x7ffffff0)).toBe(false)

    const closed = new KillOnCloseJob()
    closed.close()
    expect(closed.assign(q.pid)).toBe(false)
  })
})
