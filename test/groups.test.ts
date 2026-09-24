import { describe, expect, it } from 'vitest'
import { depthOf, drawOrder, isInHidden, moveAmongSiblings, nestGroup, placeGroup, removeGroup, setGroupHidden, type GroupNode } from '../src/shared/groups'
import { sortBySection } from '../src/shared/arrange'

// empresaA > clienteX > fase1 ; empresaB ; pessoal (oculta)
const groups: GroupNode[] = [
  { id: 'empresaA' },
  { id: 'clienteX', parentId: 'empresaA' },
  { id: 'empresaB' },
  { id: 'fase1', parentId: 'clienteX' },
  { id: 'pessoal', hidden: true },
  { id: 'hobby', parentId: 'pessoal' }
]
const ids = (list: { id: string }[]): string => list.map((g) => g.id).join(',')

describe('árvore de categorias', () => {
  it('desenha em profundidade: a categoria, as de dentro, depois a próxima; ocultas à parte', () => {
    const { visible, hidden } = drawOrder(groups)
    expect(ids(visible)).toBe('empresaA,clienteX,fase1,empresaB')
    expect(ids(hidden)).toBe('pessoal,hobby')
    expect(depthOf(groups, 'fase1')).toBe(2)
    expect(depthOf(groups, 'empresaB')).toBe(0)
  })

  it('subcategoria de uma categoria oculta também está em Ocultos', () => {
    expect(isInHidden(groups, 'hobby')).toBe(true)
    expect(isInHidden(groups, 'fase1')).toBe(false)
  })

  it('categoria cuja mãe foi apagada aparece na raiz', () => {
    expect(ids(drawOrder([{ id: 'orfa', parentId: 'sumiu' }, { id: 'raiz' }]).visible)).toBe('orfa,raiz')
  })

  it('aninhar: vai para o fim da categoria de destino; nunca dentro dela mesma ou de uma filha', () => {
    const nested = nestGroup(groups, 'empresaB', 'empresaA')
    expect(ids(drawOrder(nested).visible)).toBe('empresaA,clienteX,fase1,empresaB')
    expect(nested.find((g) => g.id === 'empresaB')?.parentId).toBe('empresaA')
    expect(nestGroup(groups, 'empresaA', 'fase1')).toBe(groups)
    expect(nestGroup(groups, 'empresaA', 'empresaA')).toBe(groups)
    const toRoot = nestGroup(groups, 'clienteX', null)
    expect(ids(drawOrder(toRoot).visible)).toBe('empresaA,empresaB,clienteX,fase1')
  })

  it('ocultar leva a categoria com tudo dentro para Ocultos; mostrar volta para a raiz', () => {
    const hidden = setGroupHidden(groups, 'clienteX', true)
    expect(ids(drawOrder(hidden).hidden)).toBe('clienteX,fase1,pessoal,hobby')
    expect(isInHidden(hidden, 'fase1')).toBe(true)
    const shown = setGroupHidden(groups, 'pessoal', false)
    expect(ids(drawOrder(shown).visible)).toBe('empresaA,clienteX,fase1,empresaB,pessoal,hobby')
  })

  it('arrastar para a borda de outra categoria põe antes ou depois dela, no mesmo nível', () => {
    expect(ids(drawOrder(placeGroup(groups, 'empresaB', 'empresaA', 'before')).visible)).toBe('empresaB,empresaA,clienteX,fase1')
    expect(ids(drawOrder(placeGroup(groups, 'empresaA', 'empresaB', 'after')).visible)).toBe('empresaB,empresaA,clienteX,fase1')
    const sub = placeGroup(groups, 'empresaB', 'clienteX', 'after')
    expect(sub.find((g) => g.id === 'empresaB')?.parentId).toBe('empresaA')
    expect(ids(drawOrder(sub).visible)).toBe('empresaA,clienteX,fase1,empresaB')
    const out = placeGroup(groups, 'fase1', 'empresaB', 'before')
    expect(out.find((g) => g.id === 'fase1')?.parentId).toBeUndefined()
    expect(ids(drawOrder(out).visible)).toBe('empresaA,clienteX,fase1,empresaB')
  })

  it('ao lado de uma categoria oculta fica em Ocultos; nunca ao lado de uma filha dela mesma', () => {
    const hidden = placeGroup(groups, 'empresaB', 'pessoal', 'after')
    expect(ids(drawOrder(hidden).hidden)).toBe('pessoal,hobby,empresaB')
    expect(placeGroup(groups, 'empresaA', 'fase1', 'after')).toBe(groups)
    expect(placeGroup(groups, 'empresaA', 'empresaA', 'after')).toBe(groups)
  })

  it('subir e descer só entre irmãs', () => {
    expect(ids(drawOrder(moveAmongSiblings(groups, 'empresaB', -1)).visible)).toBe('empresaB,empresaA,clienteX,fase1')
    expect(moveAmongSiblings(groups, 'clienteX', -1)).toBe(groups)
    expect(moveAmongSiblings(groups, 'fase1', 1)).toBe(groups)
  })

  it('excluir sobe projetos e subcategorias um nível', () => {
    const projects = [{ id: 'p1', groupId: 'clienteX' }, { id: 'p2', groupId: 'empresaA' }, { id: 'p3' }]
    const r = removeGroup(groups, projects, 'clienteX')
    expect(r.groups.find((g) => g.id === 'fase1')?.parentId).toBe('empresaA')
    expect(r.projects).toEqual([{ id: 'p1', groupId: 'empresaA' }, { id: 'p2', groupId: 'empresaA' }, { id: 'p3' }])
    const top = removeGroup(groups, projects, 'empresaA')
    expect(top.groups.find((g) => g.id === 'clienteX')).toEqual({ id: 'clienteX' })
    expect(top.projects.find((p) => p.id === 'p2')).toEqual({ id: 'p2' })
  })

  it('excluir uma categoria oculta mantém as de dentro em Ocultos', () => {
    const r = removeGroup(groups, [], 'pessoal')
    expect(r.groups.find((g) => g.id === 'hobby')).toEqual({ id: 'hobby', hidden: true })
  })

  it('projetos seguem a ordem da árvore na lateral', () => {
    const projects = [
      { id: 'b', groupId: 'empresaB' },
      { id: 'f', groupId: 'fase1' },
      { id: 'h', groupId: 'hobby' },
      { id: 'o', hidden: true },
      { id: 'a', groupId: 'empresaA' },
      { id: 's' }
    ]
    expect(ids(sortBySection(projects, groups))).toBe('s,a,f,b,o,h')
  })
})
