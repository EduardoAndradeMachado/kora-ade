import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const events = vi.hoisted(() => [] as string[])
const failure = vi.hoisted(() => ({ onSync: false }))

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        events.push('sync')
        if (failure.onSync) throw new Error('disco cheio')
        await sync()
      }
      return handle
    },
    rename: async (from: string, to: string) => {
      events.push('rename')
      await real.rename(from, to)
    }
  }
})

import { writeJsonAtomic } from '../src/main/claude-accounts'

const newDir = (): string => mkdtempSync(join(tmpdir(), 'kora-cofre-'))

describe('gravação do cofre de contas', () => {
  beforeEach(() => {
    events.length = 0
    failure.onSync = false
  })

  it('força os dados para o disco antes de o nome apontar para eles', async () => {
    const file = join(newDir(), 'cofre.json')

    await writeJsonAtomic(file, { a: 1 })

    expect(events).toEqual(['sync', 'rename'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 })
  })

  it('falha na gravação não deixa o token em um .tmp esquecido', async () => {
    const dir = newDir()
    failure.onSync = true

    await expect(writeJsonAtomic(join(dir, 'cofre.json'), { token: 'x' })).rejects.toThrow('disco cheio')

    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, 'cofre.json'))).toBe(false)
  })
})
