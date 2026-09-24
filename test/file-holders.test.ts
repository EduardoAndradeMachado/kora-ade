import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileHolders } from '../src/main/processes'

const children: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
})

describe('fileHolders (Restart Manager real do Windows)', () => {
  it('aponta o processo que está com o arquivo aberto, e só ele', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-rm-'))
    const held = join(dir, 'thread.lock')
    const free = join(dir, 'livre.lock')
    writeFileSync(held, '')
    writeFileSync(free, '')
    const holder = spawn(process.execPath, [
      '-e',
      `require('fs').openSync(${JSON.stringify(held)}, 'r+'); console.log('aberto'); setTimeout(() => {}, 20000)`
    ])
    children.push(holder)
    await new Promise((r) => holder.stdout!.once('data', r))

    expect(fileHolders(held)).toEqual([holder.pid])
    expect(fileHolders(free)).toEqual([])
  })
})
