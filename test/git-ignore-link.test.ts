import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Criar link simbólico de arquivo pede Modo de Desenvolvedor ou administrador no Windows. Aqui o realpath devolve o
// que o Windows devolveria para um ".gitignore" que é link para fora do projeto; o resto do disco é real.
const link = vi.hoisted(() => ({ from: '', to: '' }))
vi.mock('node:fs', async (load) => {
  const real = await load<typeof import('node:fs')>()
  const native = ((path: string, opts?: unknown) =>
    link.from && resolve(String(path)).toLowerCase() === link.from.toLowerCase()
      ? link.to
      : (real.realpathSync.native as (p: string, o?: unknown) => string)(path, opts)) as typeof real.realpathSync.native
  return { ...real, realpathSync: Object.assign(real.realpathSync.bind(null), { native }) }
})

const { gitAddToIgnore } = await import('../src/main/git-ignore')

let dir: string
afterEach(() => {
  link.from = ''
  rmSync(dir, { recursive: true, force: true })
})

describe('.gitignore que é link para fora do projeto', () => {
  it('recusa e não grava no arquivo de fora', () => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-ignore-link-')))
    const project = join(dir, 'projeto')
    const outside = join(dir, 'fora.txt')
    writeFileSync(outside, 'de fora\n')
    mkdirSync(project)
    writeFileSync(join(project, '.gitignore'), 'antes\n')
    writeFileSync(join(project, 'segredo.env'), 'x')
    link.from = join(project, '.gitignore')
    link.to = outside

    expect(() => gitAddToIgnore(project, ['segredo.env'])).toThrow(/fora do projeto/)
    expect(readFileSync(outside, 'utf8')).toBe('de fora\n')
    expect(existsSync(join(project, '.gitignore')) && readFileSync(join(project, '.gitignore'), 'utf8')).toBe('antes\n')
  })
})
