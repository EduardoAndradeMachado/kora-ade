import { describe, expect, it } from 'vitest'
import { applyLayout } from '../src/main/projects'
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
