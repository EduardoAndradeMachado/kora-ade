import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { terminalCwd } from '../src/main/terminals'
import { mergeTabs } from '../src/main/projects'
import { emptyState, StateSchema, type KoraState } from '../src/shared/state'

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-cwd-')))
const root = join(base, 'projeto')
const outside = join(base, 'fora')
mkdirSync(join(root, 'src', 'lib'), { recursive: true })
mkdirSync(outside)
writeFileSync(join(root, 'src', 'a.ts'), '')
// Junção não pede privilégio de administrador no Windows, ao contrário do link simbólico de pasta.
symlinkSync(outside, join(root, 'atalho'), 'junction')

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('terminalCwd', () => {
  it('pasta do projeto vira a pasta inicial; sem pasta, a raiz', () => {
    expect(terminalCwd(root, 'src\\lib')).toBe(join(root, 'src', 'lib'))
    expect(terminalCwd(root, 'src/lib')).toBe(join(root, 'src', 'lib'))
    expect(terminalCwd(root, undefined)).toBe(root)
    expect(terminalCwd(root, '')).toBe(root)
  })

  it('pasta que sumiu (ou que é arquivo) volta para a raiz em vez de a aba não abrir mais', () => {
    expect(terminalCwd(root, 'apagada')).toBe(root)
    expect(terminalCwd(root, 'src\\a.ts')).toBe(root)
  })

  it('fora do projeto não abre, nem por "..", nem por caminho absoluto, nem por junção', () => {
    expect(() => terminalCwd(root, '..\\fora')).toThrow(/fora do projeto/)
    expect(() => terminalCwd(root, outside)).toThrow(/fora do projeto/)
    expect(() => terminalCwd(root, 'atalho')).toThrow(/fora do projeto/)
  })
})

describe('pasta do terminal no estado salvo', () => {
  const state: KoraState = { ...emptyState(), projects: [{ id: 'p', name: 'p', path: 'C:/p' }] }

  it('sobrevive a reabrir o app: o save guarda e a leitura do arquivo de estado mantém', () => {
    const saved = mergeTabs(state, [{ id: 't', projectId: 'p', title: 'lib', dir: 'src\\lib' }])
    const reloaded = StateSchema.parse(JSON.parse(JSON.stringify(saved)))
    expect(reloaded.tabs).toEqual([{ id: 't', projectId: 'p', title: 'lib', titleLocked: false, agent: null, dir: 'src\\lib' }])
  })

  it('save posterior sem a pasta (lista vinda do celular) não a apaga; valor que não é texto não entra', () => {
    const saved = mergeTabs(state, [{ id: 't', projectId: 'p', title: 'lib', dir: 'src\\lib' }])
    const renamed = mergeTabs(saved, [{ id: 't', projectId: 'p', title: 'Build', titleLocked: true }])
    expect(renamed.tabs[0]).toMatchObject({ title: 'Build', dir: 'src\\lib' })
    const junk = mergeTabs(state, [{ id: 'x', projectId: 'p', title: 'x', dir: 42 as unknown as string }])
    expect(junk.tabs[0]).not.toHaveProperty('dir')
    expect(() => StateSchema.parse(JSON.parse(JSON.stringify(junk)))).not.toThrow()
  })
})
