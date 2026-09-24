import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectWatchers, classify } from '../src/main/project-watcher'
import type { FilesChange } from '../src/shared/ipc'

let root: string
let watchers: ProjectWatchers
let calls: { projectId: string; change: FilesChange }[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kora-watch-'))
  mkdirSync(join(root, 'docs', 'svg'), { recursive: true })
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true })
  writeFileSync(join(root, 'docs', 'svg', 'logo.svg'), '<svg/>')
  writeFileSync(join(root, 'README.md'), '# oi\n')
  writeFileSync(join(root, '.gitignore'), 'dist/\n')
  calls = []
  watchers = new ProjectWatchers((projectId, change) => calls.push({ projectId, change }), 50)
})

afterEach(() => {
  watchers.closeAll()
  rmSync(root, { recursive: true, force: true })
})

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('o que cada evento do disco muda para a interface', () => {
  it('criar, apagar ou mover muda a listagem da pasta (raiz como vazio) e o status do git', () => {
    expect(classify('rename', 'docs\\svg\\logo.svg')).toEqual({ dirs: ['docs\\svg'], git: true, ignoreRules: false, rescan: false })
    expect(classify('rename', 'README.md').dirs).toEqual([''])
  })

  it('editar conteúdo não muda a listagem, mas muda o status do git', () => {
    expect(classify('change', 'src\\app.ts')).toEqual({ dirs: [], git: true, ignoreRules: false, rescan: false })
  })

  it('.gitignore editado (em qualquer pasta) muda as regras de ignorados', () => {
    expect(classify('change', '.gitignore').ignoreRules).toBe(true)
    expect(classify('change', 'pacote\\.gitignore').ignoreRules).toBe(true)
    expect(classify('change', '.git\\info\\exclude').ignoreRules).toBe(true)
  })

  it('dentro do .git só index, HEAD e refs mexem no status; objetos e travas não avisam nada', () => {
    expect(classify('change', '.git\\index').git).toBe(true)
    expect(classify('change', '.git\\HEAD').git).toBe(true)
    expect(classify('rename', '.git\\refs\\heads\\main').git).toBe(true)
    expect(classify('rename', '.git\\index.lock')).toEqual({ dirs: [], git: false, ignoreRules: false, rescan: false })
    expect(classify('rename', '.git\\objects\\ab\\cdef')).toEqual({ dirs: [], git: false, ignoreRules: false, rescan: false })
  })

  it('evento sem nome (buffer do Windows estourou) pede para reler tudo', () => {
    expect(classify('rename', null)).toEqual({ dirs: [], git: true, ignoreRules: true, rescan: true })
  })
})

describe('observador de pastas do projeto (watcher real)', () => {
  it('arquivo movido por fora avisa as duas pastas afetadas, agrupado num aviso só', async () => {
    watchers.watch('p1', root)
    await settle(100)
    renameSync(join(root, 'docs', 'svg', 'logo.svg'), join(root, 'docs', 'logo.svg'))
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.projectId).toBe('p1')
    expect(new Set(calls[0]!.change.dirs)).toEqual(new Set(['docs\\svg', 'docs']))
  })

  it('.gitignore salvo por fora chega como mudança de regras de ignorados', async () => {
    watchers.watch('p1', root)
    await settle(100)
    appendFileSync(join(root, '.gitignore'), 'build/\n')
    await settle()
    expect(calls.some((c) => c.change.ignoreRules && c.change.git)).toBe(true)
  })

  it('conteúdo editado avisa o git sem pedir para reler pasta', async () => {
    watchers.watch('p1', root)
    await settle(100)
    appendFileSync(join(root, 'README.md'), 'mais\n')
    await settle()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.change.dirs.length === 0 && !c.change.ignoreRules)).toBe(true)
    expect(calls.some((c) => c.change.git)).toBe(true)
  })

  it('objeto novo e trava dentro do .git não avisam', async () => {
    watchers.watch('p1', root)
    await settle(100)
    writeFileSync(join(root, '.git', 'index.lock'), '')
    writeFileSync(join(root, '.git', 'objects', 'ab', 'cdef'), 'x')
    await settle()
    expect(calls).toEqual([])
  })

  it('branch nova (ref gravada) avisa o git', async () => {
    watchers.watch('p1', root)
    await settle(100)
    writeFileSync(join(root, '.git', 'refs', 'heads', 'nova'), 'abc\n')
    await settle()
    expect(calls.some((c) => c.change.git)).toBe(true)
  })

  it('gravação sem pausa ainda avisa dentro do tempo máximo de espera', async () => {
    watchers.closeAll()
    watchers = new ProjectWatchers((projectId, change) => calls.push({ projectId, change }), 200, 500)
    watchers.watch('p1', root)
    await settle(100)
    const started = Date.now()
    while (Date.now() - started < 1200) {
      appendFileSync(join(root, 'README.md'), 'x')
      await settle(40)
    }
    expect(calls.length).toBeGreaterThanOrEqual(1)
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
