import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const blockedRenames = vi.hoisted(() => ({ left: 0, code: 'EPERM' }))
const blockedReads = vi.hoisted(() => ({ left: 0, path: null as string | null, code: 'EBUSY' }))

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return {
    ...real,
    fsyncSync: (fd: number) => {
      calls.push('fsync')
      real.fsyncSync(fd)
    },
    renameSync: (from: string, to: string) => {
      calls.push('rename')
      if (blockedRenames.left > 0) {
        blockedRenames.left--
        throw Object.assign(new Error('preso'), { code: blockedRenames.code })
      }
      real.renameSync(from, to)
    },
    readFileSync: ((path: string, options: BufferEncoding) => {
      if (blockedReads.left > 0 && (blockedReads.path === null || blockedReads.path === path)) {
        blockedReads.left--
        throw Object.assign(new Error('preso'), { code: blockedReads.code })
      }
      return real.readFileSync(path, options)
    }) as typeof real.readFileSync
  }
})

import { renameRetrying, replaceDurable } from '../src/main/durable-file'
import { loadState, recoveryMessage, saveState } from '../src/main/store'
import { emptyState, type KoraState } from '../src/shared/state'

const newFile = (): string => join(mkdtempSync(join(tmpdir(), 'kora-durable-')), 'dados.json')

beforeEach(() => {
  calls.length = 0
  blockedRenames.left = 0
  blockedRenames.code = 'EPERM'
  blockedReads.left = 0
  blockedReads.path = null
  blockedReads.code = 'EBUSY'
})

describe('gravação durável', () => {
  it('força os dados para o disco antes de o nome apontar para eles', () => {
    const file = newFile()

    replaceDurable(file, '{"a":1}')

    expect(calls).toEqual(['fsync', 'rename'])
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it('saveState passa pelo fsync antes de qualquer rename', () => {
    const file = newFile()
    const state = { ...emptyState(), projects: [{ id: 'p', name: 'a', path: 'C:\\x' }] }
    saveState(file, state)
    calls.length = 0

    saveState(file, state)

    expect(calls.slice(0, 3)).toEqual(['fsync', 'rename', 'rename'])
  })

  it('arquivo preso por instantes é tentado de novo', () => {
    const file = newFile()
    blockedRenames.left = 3

    replaceDurable(file, '{"a":1}')

    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])('%s conta como trava passageira', (code) => {
    const file = newFile()
    blockedRenames.left = 1
    blockedRenames.code = code

    replaceDurable(file, '{"a":1}')

    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it('arquivo preso para sempre desiste e relata', () => {
    const file = newFile()
    writeFileSync(file, 'x')
    blockedRenames.left = 100

    expect(() => renameRetrying(file, `${file}.outro`)).toThrow('preso')
  })

  it('erro que não é trava não é tentado de novo', () => {
    const file = newFile()
    blockedRenames.left = 1
    blockedRenames.code = 'ENOSPC'

    expect(() => renameRetrying(file, `${file}.outro`)).toThrow('preso')
    expect(calls).toEqual(['rename'])
  })

  it('falha ao gravar não deixa a chave privada num .tmp esquecido', () => {
    const file = newFile()
    blockedRenames.left = 100

    expect(() => replaceDurable(file, '{"chave":"secreta"}')).toThrow('preso')

    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  describe('arquivo preso na abertura', () => {
    const withProject = (name: string): KoraState => ({ ...emptyState(), projects: [{ id: 'p', name, path: 'C:\\x' }] })
    let errors: MockInstance

    beforeEach(() => {
      errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => errors.mockRestore())

    it('.tmp que é a única cópia boa e não consegue virar principal sobrevive à gravação seguinte', () => {
      const file = newFile()
      saveState(file, withProject('atual'))
      writeFileSync(`${file}.tmp`, readFileSync(file))
      rmSync(file)
      rmSync(`${file}.snapshots`, { recursive: true })
      blockedRenames.left = 6

      expect(loadState(file).state.projects[0]?.name).toBe('atual')
      expect(existsSync(file)).toBe(false)

      saveState(file, withProject('nova'))

      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ projects: [{ name: 'nova' }] })
      expect(JSON.parse(readFileSync(`${file}.tmp`, 'utf8'))).toMatchObject({ projects: [{ name: 'atual' }] })
    })

    it('foto ilegível não prende o app: abre pela cópia boa e continua gravando', () => {
      const file = newFile()
      saveState(file, withProject('boa'))
      saveState(file, withProject('atual'))
      writeFileSync(file, Buffer.alloc(50))
      const [photo] = readdirSync(`${file}.snapshots`)
      blockedReads.left = 100
      blockedReads.path = join(`${file}.snapshots`, photo!)

      const { state, recovery } = loadState(file)
      blockedReads.left = 0
      saveState(file, withProject('depois'))

      expect(state.projects[0]?.name).toBe('boa')
      expect(recovery?.readOnly).toBe(false)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ projects: [{ name: 'depois' }] })
    })

    it('.bak com erro de disco passageiro não é sobrescrito pela gravação seguinte', () => {
      const file = newFile()
      saveState(file, withProject('boa'))
      saveState(file, withProject('atual'))
      writeFileSync(file, Buffer.alloc(50))
      const bak = readFileSync(`${file}.bak`)
      blockedReads.left = 1
      blockedReads.path = `${file}.bak`
      blockedReads.code = 'EIO'

      const { recovery } = loadState(file)
      saveState(file, withProject('depois'))
      saveState(file, withProject('mais uma'))

      expect(recovery?.readOnly).toBe(false)
      const kept = readdirSync(dirname(file)).find((name) => name.includes('.bak.corrupt-'))
      expect(readFileSync(join(dirname(file), kept!))).toEqual(bak)
    })

    it('erro de disco no principal é dano, não trava: tira do lugar e segue gravando', () => {
      const file = newFile()
      saveState(file, withProject('boa'))
      saveState(file, withProject('atual'))
      blockedReads.left = 1
      blockedReads.path = file
      blockedReads.code = 'EIO'

      const { recovery } = loadState(file)
      saveState(file, withProject('depois'))

      expect(recovery).toMatchObject({ readOnly: false })
      expect(existsSync(recovery!.corrupt!)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ projects: [{ name: 'depois' }] })
    })

    it('principal danificado que não sai do lugar: abre pela cópia, sem sobrescrevê-lo nem gravar', () => {
      const file = newFile()
      saveState(file, withProject('boa'))
      saveState(file, withProject('atual'))
      writeFileSync(file, Buffer.alloc(50))
      blockedRenames.left = 6

      const { state, recovery } = loadState(file)
      saveState(file, withProject('não pode gravar'))

      expect(state.projects[0]?.name).toBe('boa')
      expect(recovery).toMatchObject({ corrupt: null, readOnly: true })
      expect(readFileSync(file)).toEqual(Buffer.alloc(50))
    })

    it('principal bom e preso além das tentativas não é tratado como corrompido nem substituído', () => {
      const file = newFile()
      saveState(file, withProject('boa'))
      saveState(file, withProject('atual'))
      const before = readFileSync(file)
      blockedReads.left = 6
      blockedReads.path = file

      const { state, recovery } = loadState(file)
      saveState(file, withProject('não pode gravar'))

      expect(state.projects[0]?.name).toBe('boa')
      expect(recovery).toMatchObject({ corrupt: null, readOnly: true })
      expect(readFileSync(file)).toEqual(before)
      expect(readdirSync(dirname(file)).some((name) => name.includes('.corrupt-'))).toBe(false)
      expect(recoveryMessage(recovery!)).toContain('saia pelo ícone da bandeja')
    })

    it('primeira abertura sem cópias e com o principal preso não vira lista vazia gravável', () => {
      const file = newFile()
      saveState(file, withProject('única'))
      rmSync(`${file}.snapshots`, { recursive: true })
      blockedReads.left = 6

      const { state, recovery } = loadState(file)
      saveState(file, emptyState())
      saveState(file, emptyState())

      expect(state.projects).toEqual([])
      expect(recovery).toMatchObject({ source: null, readOnly: true })
      expect(loadState(file).state.projects[0]?.name).toBe('única')
    })

    it('reabrir depois de soltar a trava volta ao normal e grava de novo', () => {
      const file = newFile()
      saveState(file, withProject('atual'))
      blockedReads.left = 6
      loadState(file)

      expect(loadState(file).recovery).toBeNull()
      saveState(file, withProject('depois'))
      expect(loadState(file).state.projects[0]?.name).toBe('depois')
    })

    it('cópia presa com o principal danificado também impede gravar', () => {
      const file = newFile()
      saveState(file, withProject('boa'))
      saveState(file, withProject('atual'))
      writeFileSync(file, Buffer.alloc(50))
      blockedReads.left = 100
      blockedReads.path = `${file}.bak`

      const { recovery } = loadState(file)

      expect(recovery?.readOnly).toBe(true)
      expect(existsSync(file)).toBe(false)
    })
  })

  it('leitura presa por instantes não vira arquivo corrompido', () => {
    const file = newFile()
    saveState(file, emptyState())
    blockedReads.left = 2

    expect(loadState(file).recovery).toBeNull()
  })
})
