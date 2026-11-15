import { linkSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Queda de energia não dá para provocar no teste: o que dá é parar a gravação nos pontos onde ela pararia
// (disco cheio no meio da escrita, falha de E/S no fsync) e olhar o que ficou no disco naquele instante.
const disk = vi.hoisted(() => ({
  fds: new Map<number, string>(),
  events: [] as { op: 'fsync' | 'rename'; path: string; original: string | null }[],
  watched: null as string | null,
  failWrite: null as string | null,
  failFsync: null as string | null
}))

vi.mock('node:fs', async (load) => {
  const real = await load<typeof import('node:fs')>()
  const originalNow = (): string | null => (disk.watched ? real.readFileSync(disk.watched, 'utf8') : null)
  return {
    ...real,
    openSync: ((path: string, ...rest: Parameters<typeof real.openSync> extends [unknown, ...infer R] ? R : never) => {
      const fd = real.openSync(path, ...rest)
      disk.fds.set(fd, String(path))
      return fd
    }) as typeof real.openSync,
    writeSync: ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
      const path = disk.fds.get(fd) ?? ''
      if (disk.failWrite && path.endsWith(disk.failWrite)) {
        real.writeSync(fd, buffer, offset, Math.floor(length / 2), position)
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      return real.writeSync(fd, buffer, offset, length, position)
    }) as typeof real.writeSync,
    fsyncSync: (fd: number) => {
      const path = disk.fds.get(fd) ?? ''
      disk.events.push({ op: 'fsync', path, original: originalNow() })
      if (disk.failFsync && path.endsWith(disk.failFsync)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
      real.fsyncSync(fd)
    },
    renameSync: (from: string, to: string) => {
      disk.events.push({ op: 'rename', path: String(to), original: originalNow() })
      real.renameSync(from, to)
    }
  }
})

const { readText, writeText } = await import('../src/main/files')

let root: string
const file = (): string => join(root, 'dados.txt')
const OLD = 'conteúdo que já estava salvo\n'.repeat(200)
const NEW = 'versão nova do arquivo\n'.repeat(300)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kora-safe-crash-'))
  writeFileSync(file(), OLD)
  disk.fds.clear()
  disk.events.length = 0
  disk.watched = file()
  disk.failWrite = null
  disk.failFsync = null
})

const saveNew = (): number => writeText(root, 'dados.txt', NEW, readText(root, 'dados.txt').mtimeMs)
const leftovers = (): string[] => readdirSync(root).filter((name) => name !== 'dados.txt')

describe('salvar no meio de uma falha', () => {
  it('o texto novo chega ao disco antes de tomar o lugar do original, que até ali segue intacto', () => {
    saveNew()
    const fsync = disk.events.findIndex((e) => e.op === 'fsync' && e.path.endsWith('.kora-tmp'))
    const rename = disk.events.findIndex((e) => e.op === 'rename')
    expect(fsync).toBeGreaterThanOrEqual(0)
    expect(rename).toBeGreaterThan(fsync)
    // Uma queda em qualquer ponto até o rename encontraria o original inteiro.
    for (const event of disk.events.slice(0, rename + 1)) expect(event.original).toBe(OLD)
    expect(readFileSync(file(), 'utf8')).toBe(NEW)
  })

  it('disco cheio no meio da escrita: o original fica inteiro e o temporário pela metade some', () => {
    disk.failWrite = '.kora-tmp'
    expect(() => saveNew()).toThrow(/Disco cheio.*dados\.txt/)
    expect(readFileSync(file(), 'utf8')).toBe(OLD)
    expect(leftovers()).toEqual([])
  })

  it('falha de E/S ao forçar para o disco: o original fica inteiro e nada sobra na pasta', () => {
    disk.failFsync = '.kora-tmp'
    expect(() => saveNew()).toThrow(/EIO/)
    expect(readFileSync(file(), 'utf8')).toBe(OLD)
    expect(leftovers()).toEqual([])
  })

  it('falha no meio da gravação no próprio arquivo (hard link): o texto salvo inteiro fica numa cópia com nome claro', () => {
    linkSync(file(), join(root, 'outro-nome.txt'))
    disk.failWrite = 'dados.txt'
    expect(() => saveNew()).toThrow(/Disco cheio.*dados\.txt.*dados\.kora-recuperado-[0-9a-f]+\.txt/s)
    const copies = leftovers().filter((name) => name !== 'outro-nome.txt')
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(/^dados\.kora-recuperado-[0-9a-f]+\.txt$/)
    expect(readFileSync(join(root, copies[0]!), 'utf8')).toBe(NEW)
  })

  it('gravação no próprio arquivo que termina bem não deixa a cópia de recuperação para trás', () => {
    linkSync(file(), join(root, 'outro-nome.txt'))
    saveNew()
    expect(readFileSync(join(root, 'outro-nome.txt'), 'utf8')).toBe(NEW)
    expect(leftovers()).toEqual(['outro-nome.txt'])
  })
})
