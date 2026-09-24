import { describe, expect, it } from 'vitest'
import { arrangeProjects, moveBy, reorder, sortBySection, ungroup } from '../src/shared/arrange'

const ids = (list: { id: string }[]): string => list.map((i) => i.id).join(',')
const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

describe('reordenar abas', () => {
  it('antes e depois do alvo, nos dois sentidos', () => {
    expect(ids(reorder(tabs, 'a', 'c', 'after'))).toBe('b,c,a,d')
    expect(ids(reorder(tabs, 'a', 'c', 'before'))).toBe('b,a,c,d')
    expect(ids(reorder(tabs, 'd', 'a', 'before'))).toBe('d,a,b,c')
    expect(ids(reorder(tabs, 'd', 'b', 'after'))).toBe('a,b,d,c')
  })

  it('sobre si mesmo ou com id desconhecido não mexe', () => {
    expect(reorder(tabs, 'b', 'b', 'after')).toBe(tabs)
    expect(reorder(tabs, 'x', 'b', 'after')).toBe(tabs)
    expect(reorder(tabs, 'a', 'x', 'after')).toBe(tabs)
  })
})

type P = { id: string; hidden?: boolean; groupId?: string }
const where = (list: P[]): string =>
  list.map((p) => `${p.id}:${p.hidden ? 'oculto' : (p.groupId ?? '-')}`).join(' ')

describe('projetos em seções: sem categoria, categorias e Ocultos', () => {
  const groups = [{ id: 'empresaA' }, { id: 'empresaB' }]
  const projects: P[] = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c', groupId: 'empresaA' },
    { id: 'd', groupId: 'empresaB' },
    { id: 'e', hidden: true }
  ]

  it('soltar sobre um projeto de outra categoria leva o projeto para ela, na posição', () => {
    expect(where(arrangeProjects(projects, 'a', { kind: 'project', id: 'c', place: 'before' }, groups))).toBe(
      'b:- a:empresaA c:empresaA d:empresaB e:oculto'
    )
  })

  it('soltar no cabeçalho da categoria vai para o fim dela; em Ocultos oculta; na seção sem categoria tira a categoria', () => {
    expect(where(arrangeProjects(projects, 'a', { kind: 'section', section: { hidden: false, groupId: 'empresaB' } }, groups))).toBe(
      'b:- c:empresaA d:empresaB a:empresaB e:oculto'
    )
    expect(where(arrangeProjects(projects, 'c', { kind: 'section', section: { hidden: true } }, groups))).toBe(
      'a:- b:- d:empresaB e:oculto c:oculto'
    )
    expect(where(arrangeProjects(projects, 'e', { kind: 'section', section: { hidden: false, groupId: null } }, groups))).toBe(
      'a:- b:- e:- c:empresaA d:empresaB'
    )
  })

  it('ir para Ocultos tira a categoria: ao voltar, o projeto não reaparece numa empresa por engano', () => {
    const hidden = arrangeProjects(projects, 'c', { kind: 'section', section: { hidden: true } }, groups)
    expect(hidden.find((p) => p.id === 'c')).toEqual({ id: 'c', hidden: true })
  })

  it('oculto que volta para uma categoria deixa de ser oculto', () => {
    const next = arrangeProjects(projects, 'e', { kind: 'project', id: 'd', place: 'after' }, groups)
    expect(where(next)).toBe('a:- b:- c:empresaA d:empresaB e:empresaB')
  })

  it('lista sai na ordem das seções, seguindo a ordem das categorias', () => {
    const mixed: P[] = [{ id: 'x', hidden: true }, { id: 'y', groupId: 'empresaB' }, { id: 'z', groupId: 'empresaA' }, { id: 'w' }]
    expect(ids(sortBySection(mixed, groups))).toBe('w,z,y,x')
    expect(ids(sortBySection(mixed, [{ id: 'empresaB' }, { id: 'empresaA' }]))).toBe('w,y,z,x')
  })

  it('categoria inteira em Ocultos vai para depois dos projetos ocultos soltos, com os projetos dela juntos', () => {
    const mixed: P[] = [{ id: 'z', groupId: 'empresaA' }, { id: 'x', hidden: true }, { id: 'y', groupId: 'empresaB' }, { id: 'w' }, { id: 'v', groupId: 'empresaA' }]
    expect(ids(sortBySection(mixed, [{ id: 'empresaA', hidden: true }, { id: 'empresaB' }]))).toBe('w,y,x,z,v')
  })

  it('categoria que não existe mais conta como sem categoria', () => {
    expect(ids(sortBySection([{ id: 'g', groupId: 'apagada' }, { id: 'h', groupId: 'empresaA' }], groups))).toBe('g,h')
  })

  it('excluir a categoria devolve os projetos dela para sem categoria, sem mexer nos outros', () => {
    expect(where(ungroup(projects, 'empresaA'))).toBe('a:- b:- c:- d:empresaB e:oculto')
  })

  it('não altera o projeto original (estado imutável)', () => {
    arrangeProjects(projects, 'a', { kind: 'section', section: { hidden: true } }, groups)
    expect(projects[0]).toEqual({ id: 'a' })
  })
})

describe('ordem das categorias', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('sobe e desce uma posição, sem passar das pontas', () => {
    expect(ids(moveBy(list, 'b', -1))).toBe('b,a,c')
    expect(ids(moveBy(list, 'b', 1))).toBe('a,c,b')
    expect(moveBy(list, 'a', -1)).toBe(list)
    expect(moveBy(list, 'c', 1)).toBe(list)
  })
})
