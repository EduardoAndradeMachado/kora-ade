import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectWatchers, listingDirOf } from '../src/main/project-watcher'

let root: string
let watchers: ProjectWatchers
let calls: { projectId: string; dirs: string[] }[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kora-watch-'))
  mkdirSync(join(root, 'docs', 'svg'), { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'docs', 'svg', 'logo.svg'), '<svg/>')
  calls = []
  watchers = new ProjectWatchers((projectId, dirs) => calls.push({ projectId, dirs }), 50)
})

afterEach(() => {
  watchers.closeAll()
  rmSync(root, { recursive: true, force: true })
})

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('observador de pastas do projeto', () => {
  it('pasta da listagem que mudou, com raiz como vazio e .git ignorado', () => {
    expect(listingDirOf('docs\\svg\\logo.svg')).toBe('docs\\svg')
    expect(listingDirOf('README.md')).toBe('')
    expect(listingDirOf('.git\\index.lock')).toBeNull()
  })

  it('arquivo movido por fora avisa as duas pastas afetadas, agrupado num aviso só', async () => {
    watchers.watch('p1', root)
    await settle(100)
    renameSync(join(root, 'docs', 'svg', 'logo.svg'), join(root, 'docs', 'logo.svg'))
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.projectId).toBe('p1')
    expect(new Set(calls[0]!.dirs)).toEqual(new Set(['docs\\svg', 'docs']))
  })

  it('mudança só dentro do .git não avisa', async () => {
    watchers.watch('p1', root)
    await settle(100)
    writeFileSync(join(root, '.git', 'index.lock'), '')
    await settle()
    expect(calls).toEqual([])
  })

  it('depois de parar de observar, nada mais chega', async () => {
    watchers.watch('p1', root)
    await settle(100)
    watchers.unwatch('p1')
    writeFileSync(join(root, 'novo.txt'), 'x')
    await settle()
    expect(calls).toEqual([])
  })
})
