import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { descendants, listProcesses, withCreationTime, type ProcInfo } from '../src/main/processes'

const children: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
})

describe('listProcesses (Toolhelp real do Windows)', () => {
  it('enxerga um processo filho com o pai e o nome certos', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'])
    children.push(child)
    await new Promise((r) => setTimeout(r, 300))

    const found = listProcesses().find((p) => p.pid === child.pid)

    expect(found?.ppid).toBe(process.pid)
    expect(found?.name.toLowerCase()).toBe('node.exe')
  })

  it('neto aparece como descendente do processo atual', async () => {
    const child = spawn(process.execPath, [
      '-e',
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']); console.log(c.pid); setTimeout(() => c.kill(), 20000)"
    ])
    children.push(child)
    const grandchildPid = await new Promise<number>((r) => child.stdout!.once('data', (d) => r(Number(String(d).trim()))))

    const tree = descendants(process.pid, listProcesses()).map((p) => p.pid)

    expect(tree).toContain(child.pid)
    expect(tree).toContain(grandchildPid)
  })

  it('horário de criação bate com o momento do spawn', async () => {
    const before = Date.now()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'])
    children.push(child)
    await new Promise((r) => setTimeout(r, 300))

    const created = withCreationTime({ pid: child.pid!, ppid: 0, name: '', createdMs: null }).createdMs

    expect(created).not.toBeNull()
    expect(Math.abs(created! - before)).toBeLessThan(2000)
  })
})

describe('descendants', () => {
  it('não entra em laço quando o pid se repete na tabela', () => {
    const procs: ProcInfo[] = [
      { pid: 1, ppid: 0, name: 'a', createdMs: null },
      { pid: 2, ppid: 1, name: 'b', createdMs: null },
      { pid: 1, ppid: 2, name: 'reuso', createdMs: null }
    ]
    expect(descendants(1, procs).map((p) => p.pid)).toEqual([2])
  })
})
