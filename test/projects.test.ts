import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  applyLayout,
  forgetSessionName,
  mergeTabs,
  missingProjectIds,
  namedSessions,
  relocateProject,
  renameProject,
  setTabAgent
} from '../src/main/projects'
import { emptyState, type KoraState } from '../src/shared/state'

const state: KoraState = {
  ...emptyState(),
  groups: [{ id: 'g1', name: 'Empresa A' }],
  projects: [
    { id: 'a', name: 'a', path: 'C:/a' },
    { id: 'b', name: 'b', path: 'C:/b', groupId: 'g1' },
    { id: 'c', name: 'c', path: 'C:/c', hidden: true }
  ]
}
const groups = [{ id: 'g1', name: 'Empresa A' }, { id: 'g2', name: 'Empresa B', collapsed: true }]

describe('nome do projeto mostrado no Kora', () => {
  const named = { ...emptyState(), projects: [{ id: 'a', name: 'a', path: 'C:/dev/pasta-real', groupId: 'g1' }, { id: 'b', name: 'b', path: 'C:/b' }] }

  it('troca só o nome: caminho, categoria e os outros projetos ficam iguais', () => {
    const next = renameProject(named, 'a', '  Site da Empresa  ')
    expect(next.projects).toEqual([{ id: 'a', name: 'Site da Empresa', path: 'C:/dev/pasta-real', groupId: 'g1' }, named.projects[1]])
  })

  it('nome vazio volta ao nome da pasta', () => {
    const renamed = renameProject(named, 'a', 'Apelido')
    expect(renameProject(renamed, 'a', '   ').projects[0]!.name).toBe('pasta-real')
  })

  it('corta nome longo demais e recusa projeto que não existe', () => {
    expect(renameProject(named, 'a', 'x'.repeat(200)).projects[0]!.name).toHaveLength(60)
    expect(() => renameProject(named, 'zzz', 'Nome')).toThrow()
  })
})

describe('pasta do projeto que sumiu', () => {
  const base: KoraState = {
    ...emptyState(),
    groups: [{ id: 'g1', name: 'Empresa A' }],
    projects: [
      { id: 'a', name: 'site', path: 'C:/dev/site', groupId: 'g1' },
      { id: 'b', name: 'Meu Apelido', path: 'C:/dev/api' },
      { id: 'c', name: 'c', path: 'C:/dev/c' }
    ],
    tabs: [{ id: 't1', projectId: 'a', title: 'Claude', titleLocked: false, agent: null }]
  }

  it('lista só os projetos cuja pasta não é uma pasta existente', () => {
    const existing = new Set(['C:/dev/site', 'C:/dev/c'])
    expect(missingProjectIds(base, (path) => existing.has(path))).toEqual(['b'])
  })

  it('localizar aponta para a pasta nova e mantém id, categoria e abas; nome automático acompanha a pasta', () => {
    const next = renameProject(base, 'a', '')
    const moved = relocateProject(next, 'a', 'D:/novo/site-2026')
    expect(moved.projects[0]).toEqual({ id: 'a', name: 'site-2026', path: resolve('D:/novo/site-2026'), groupId: 'g1' })
    expect(moved.tabs).toEqual(base.tabs)
    expect(moved.projects.slice(1)).toEqual(base.projects.slice(1))
  })

  it('nome dado pelo usuário continua depois de localizar', () => {
    expect(relocateProject(base, 'b', 'D:/api-nova').projects[1]).toEqual({ id: 'b', name: 'Meu Apelido', path: resolve('D:/api-nova') })
  })

  it('recusa pasta que já é outro projeto da lista e projeto que não existe', () => {
    expect(() => relocateProject(base, 'a', 'c:/DEV/c')).toThrow('"c"')
    expect(() => relocateProject(base, 'zzz', 'D:/x')).toThrow()
  })
})

describe('organização da lateral vinda da interface', () => {
  it('aplica ordem, categoria e oculto, mantendo nome e caminho do estado salvo', () => {
    const next = applyLayout(state, {
      groups,
      placements: [
        { id: 'c', hidden: false, groupId: 'g2' },
        { id: 'a', hidden: false, groupId: null },
        { id: 'b', hidden: true, groupId: 'g1' }
      ]
    })
    expect(next.groups).toEqual(groups)
    expect(next.projects).toEqual([
      { id: 'c', name: 'c', path: 'C:/c', hidden: false, groupId: 'g2' },
      { id: 'a', name: 'a', path: 'C:/a', hidden: false },
      { id: 'b', name: 'b', path: 'C:/b', hidden: true }
    ])
  })

  it('recusa lista que perde, duplica ou inventa projeto', () => {
    const p = (id: string) => ({ id, hidden: false, groupId: null })
    expect(() => applyLayout(state, { groups, placements: [p('a'), p('b')] })).toThrow()
    expect(() => applyLayout(state, { groups, placements: [p('a'), p('a'), p('b')] })).toThrow()
    expect(() => applyLayout(state, { groups, placements: [p('a'), p('b'), p('x')] })).toThrow()
  })

  it('recusa projeto numa categoria que não existe e categoria repetida', () => {
    const placements = [
      { id: 'a', hidden: false, groupId: 'sumiu' },
      { id: 'b', hidden: false, groupId: null },
      { id: 'c', hidden: false, groupId: null }
    ]
    expect(() => applyLayout(state, { groups, placements })).toThrow(/não existe/)
    const ok = placements.map((p) => ({ ...p, groupId: null }))
    expect(() => applyLayout(state, { groups: [groups[0]!, groups[0]!], placements: ok })).toThrow(/repetida/)
  })

  it('recusa subcategoria de categoria que não existe e categoria dentro dela mesma (ciclo)', () => {
    const placements = [
      { id: 'a', hidden: false, groupId: null },
      { id: 'b', hidden: false, groupId: null },
      { id: 'c', hidden: false, groupId: null }
    ]
    expect(() => applyLayout(state, { groups: [{ id: 'g1', name: 'A', parentId: 'nada' }], placements })).toThrow(/não existe/)
    const cycle = [
      { id: 'g1', name: 'A', parentId: 'g2' },
      { id: 'g2', name: 'B', parentId: 'g1' }
    ]
    expect(() => applyLayout(state, { groups: cycle, placements })).toThrow(/dela mesma/)
    const nested = [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B', parentId: 'g1' }]
    expect(applyLayout(state, { groups: nested, placements }).groups).toEqual(nested)
  })
})

describe('nome dado à aba vira o nome da conversa na aba Sessões', () => {
  const claude = { kind: 'claude' as const, sessionId: '0a1b2c3d-0000-4000-8000-000000000001' }
  const base: KoraState = { ...emptyState(), projects: [{ id: 'a', name: 'a', path: 'C:/a' }] }
  const summary = { kind: 'claude' as const, sessionId: claude.sessionId, title: 'Título do Claude', updatedAt: 1 }

  it('renomear a aba já ligada a uma conversa guarda o nome dela', () => {
    const bound = setTabAgent(mergeTabs(base, [{ id: 't1', projectId: 'a', title: 'Claude' }]), 't1', claude)
    const renamed = mergeTabs(bound, [{ id: 't1', projectId: 'a', title: 'Inscrição SBPROPPG', titleLocked: true }])
    expect(namedSessions(renamed, [summary])).toEqual([{ ...summary, title: 'Inscrição SBPROPPG', named: true, agentTitle: 'Título do Claude' }])
  })

  it('aba renomeada antes da primeira mensagem ganha a conversa depois e o nome vai junto', () => {
    const renamed = mergeTabs(base, [{ id: 't1', projectId: 'a', title: 'Pesquisa', titleLocked: true }])
    expect(renamed.sessionNames ?? {}).toEqual({})
    const bound = setTabAgent(renamed, 't1', claude)
    expect(namedSessions(bound, [summary])[0]).toMatchObject({ title: 'Pesquisa', named: true })
  })

  it('o nome continua depois de fechar a aba; apagar o nome da aba devolve o título do agente', () => {
    const bound = setTabAgent(mergeTabs(base, [{ id: 't1', projectId: 'a', title: 'Claude' }]), 't1', claude)
    const renamed = mergeTabs(bound, [{ id: 't1', projectId: 'a', title: 'Pesquisa', titleLocked: true }])
    expect(namedSessions(mergeTabs(renamed, []), [summary])[0]!.title, 'aba fechada').toBe('Pesquisa')

    const unlocked = mergeTabs(renamed, [{ id: 't1', projectId: 'a', title: 'Pesquisa', titleLocked: false }])
    expect(namedSessions(unlocked, [summary])).toEqual([summary])
  })

  it('aba sem nome dado pelo usuário não mexe no título da conversa; conversa apagada esquece o nome', () => {
    const bound = setTabAgent(mergeTabs(base, [{ id: 't1', projectId: 'a', title: 'Claude' }]), 't1', claude)
    expect(namedSessions(bound, [summary])).toEqual([summary])
    const renamed = mergeTabs(bound, [{ id: 't1', projectId: 'a', title: 'Pesquisa', titleLocked: true }])
    expect(namedSessions(forgetSessionName(renamed, claude), [summary])).toEqual([summary])
  })
})
