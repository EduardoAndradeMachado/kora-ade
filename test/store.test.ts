import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadState, saveState } from '../src/main/store'
import { addProject, mergeTabs, removeProject, setTabAgent } from '../src/main/projects'
import { emptyState } from '../src/shared/state'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kora-store-'))
  file = join(dir, 'kora-state.json')
})

describe('persistência de projetos', () => {
  it('projetos salvos voltam iguais depois de reabrir o app', () => {
    let state = addProject(emptyState(), join(dir, 'alpha'))
    state = addProject(state, join(dir, 'beta'))
    saveState(file, state)

    const reopened = loadState(file)

    expect(reopened.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(reopened.projects.map((p) => p.path)).toEqual([join(dir, 'alpha'), join(dir, 'beta')])
  })

  it('primeira execução sem arquivo começa vazia', () => {
    expect(loadState(file).projects).toEqual([])
  })

  it('arquivo corrompido é preservado em backup, não apagado pelo próximo save', () => {
    writeFileSync(file, '{"version":1,"projects":[{"id":"x"', 'utf8')

    const state = loadState(file)
    saveState(file, state)

    const backup = readdirSync(dir).find((f) => f.includes('.corrupt-'))
    expect(backup).toBeDefined()
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe('{"version":1,"projects":[{"id":"x"')
  })

  it('a mesma pasta não entra duas vezes, mesmo com caixa diferente', () => {
    const state = addProject(emptyState(), join(dir, 'Alpha'))
    expect(addProject(state, join(dir, 'alpha')).projects).toHaveLength(1)
  })

  it('arquivo da versão 1 (só projetos) é migrado sem perder os projetos', () => {
    const v1 = { version: 1, projects: [{ id: 'p1', name: 'meu-app', path: 'C:\\x\\meu-app' }] }
    writeFileSync(file, JSON.stringify(v1), 'utf8')

    const state = loadState(file)

    expect(state.projects).toEqual(v1.projects)
    expect(state.tabs).toEqual([])
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(false)
  })

  it('abas com sessão salvas voltam com o ID depois de reabrir', () => {
    let state = addProject(emptyState(), join(dir, 'alpha'))
    const projectId = state.projects[0]!.id
    const sessionId = '01a0d12c-6ac8-7591-8c6f-3a67bf0c629e'
    state = mergeTabs(state, [{ id: 't1', projectId, title: 'Claude' }])
    state = setTabAgent(state, 't1', { kind: 'codex', sessionId })
    saveState(file, state)

    expect(loadState(file).tabs).toEqual([
      { id: 't1', projectId, title: 'Claude', titleLocked: false, agent: { kind: 'codex', sessionId } }
    ])
  })

  it('save do renderer (título/ordem) não apaga a sessão detectada pelo main', () => {
    let state = addProject(emptyState(), join(dir, 'alpha'))
    const projectId = state.projects[0]!.id
    const agent = { kind: 'claude' as const, sessionId: 'b27eef4b-c351-4f48-be43-62227ec53729' }
    state = setTabAgent(mergeTabs(state, [{ id: 't1', projectId, title: 'a' }]), 't1', agent)

    state = mergeTabs(state, [{ id: 't1', projectId, title: 'renomeada' }])

    expect(state.tabs[0]).toEqual({ id: 't1', projectId, title: 'renomeada', titleLocked: false, agent })
  })

  it('nome dado pelo usuário sobrevive ao reabrir', () => {
    let state = addProject(emptyState(), join(dir, 'alpha'))
    const projectId = state.projects[0]!.id
    state = mergeTabs(state, [{ id: 't1', projectId, title: 'Refatorar login', titleLocked: true }])
    saveState(file, state)
    expect(loadState(file).tabs[0]).toMatchObject({ title: 'Refatorar login', titleLocked: true })
  })

  it('aba salva antes de existir renomeação abre como não travada', () => {
    const saved = { version: 2, projects: [{ id: 'p1', name: 'a', path: 'C:\a' }], tabs: [{ id: 't1', projectId: 'p1', title: 'x', agent: null }] }
    writeFileSync(file, JSON.stringify(saved), 'utf8')
    expect(loadState(file).tabs[0]?.titleLocked).toBe(false)
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(false)
  })

  it('tema escolhido sobrevive ao reabrir; estado antigo sem preferência abre seguindo o sistema', () => {
    saveState(file, { ...emptyState(), settings: { ...emptyState().settings, theme: 'light' } })
    expect(loadState(file).settings.theme).toBe('light')

    writeFileSync(file, JSON.stringify({ version: 2, projects: [], tabs: [] }), 'utf8')
    expect(loadState(file).settings.theme).toBe('system')
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(false)

    writeFileSync(file, JSON.stringify({ version: 1, projects: [] }), 'utf8')
    expect(loadState(file).settings.theme).toBe('system')

    writeFileSync(file, JSON.stringify({ version: 2, projects: [], tabs: [], settings: {} }), 'utf8')
    expect(loadState(file).settings.theme).toBe('system')
  })

  it('remover projeto leva junto as abas dele', () => {
    let state = addProject(emptyState(), join(dir, 'alpha'))
    const projectId = state.projects[0]!.id
    state = mergeTabs(state, [{ id: 't1', projectId, title: 'x' }])
    expect(removeProject(state, projectId).tabs).toEqual([])
  })

  it('remover tira só o projeto escolhido', () => {
    let state = addProject(emptyState(), join(dir, 'alpha'))
    state = addProject(state, join(dir, 'beta'))
    const alpha = state.projects[0]!
    expect(removeProject(state, alpha.id).projects.map((p) => p.name)).toEqual(['beta'])
  })
})
