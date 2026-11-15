import { describe, expect, it } from 'vitest'
import { projectMatcher } from '../src/renderer/src/mobile/project-search'
import type { MobileState } from '../src/shared/mobile'

const state: Pick<MobileState, 'projects' | 'groups' | 'tabs'> = {
  groups: [{ id: 'g', name: 'Educação' }, { id: 'sub', name: 'Cliente Ágil', parentId: 'g' }],
  projects: [
    { id: 'a', name: 'Configuração', path: 'C:\\dev\\config' },
    { id: 'b', name: 'Site', path: 'C:\\dev\\site', groupId: 'sub' },
    { id: 'c', name: 'Outro', path: 'C:\\dev\\outro' }
  ],
  tabs: [{ id: 't', projectId: 'c', title: 'Revisão do Cálculo', titleLocked: false, agent: null, live: true, activity: null, holder: null }]
}
const found = (search: string): string[] => state.projects.filter(projectMatcher(state, search)).map((p) => p.id)

describe('busca de projetos no celular', () => {
  it('ignora acentos e maiúsculas no que se digita e no nome', () => {
    expect(found('configuracao')).toEqual(['a'])
    expect(found('CONFIGURAÇÃO')).toEqual(['a'])
    expect(found('calculo')).toEqual(['c'])
  })

  it('acha pelo nome da categoria e das categorias de cima', () => {
    expect(found('educacao')).toEqual(['b'])
    expect(found('agil')).toEqual(['b'])
  })

  it('busca vazia ou só com espaços mostra tudo', () => {
    expect(found('  ')).toEqual(['a', 'b', 'c'])
  })
})
