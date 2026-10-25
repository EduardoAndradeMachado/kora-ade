import { describe, expect, it } from 'vitest'
import { DESKTOP, TerminalSizes } from '../src/main/terminal-sizes'

const pc = { cols: 150, rows: 40 }
const phone = { cols: 45, rows: 30 }

describe('tamanho compartilhado do terminal', () => {
  it('sem celular, todo pedido do PC vale na hora', () => {
    const sizes = new TerminalSizes()
    expect(sizes.want('t', DESKTOP, pc)).toEqual({ ...pc, holder: DESKTOP })
    expect(sizes.want('t', DESKTOP, { cols: 120, rows: 30 })).toEqual({ cols: 120, rows: 30, holder: DESKTOP })
  })

  it('o celular que entra assume o tamanho e o PC volta ao digitar', () => {
    const sizes = new TerminalSizes()
    sizes.want('t', DESKTOP, pc)
    expect(sizes.want('t', 'cel', phone)).toBeNull()
    expect(sizes.take('t', 'cel')).toEqual({ ...phone, holder: 'cel' })
    // Janela do PC redimensionada enquanto o celular manda: guarda o pedido, não aplica.
    expect(sizes.want('t', DESKTOP, { cols: 160, rows: 42 })).toBeNull()
    expect(sizes.current('t')).toEqual({ ...phone, holder: 'cel' })
    expect(sizes.take('t', DESKTOP)).toEqual({ cols: 160, rows: 42, holder: DESKTOP })
    expect(sizes.take('t', DESKTOP)).toBeNull()
  })

  it('celular que sai devolve o tamanho ao PC, inclusive ao desconectar', () => {
    const sizes = new TerminalSizes()
    sizes.want('a', DESKTOP, pc)
    sizes.want('b', DESKTOP, pc)
    sizes.want('a', 'cel', phone)
    sizes.take('a', 'cel')
    sizes.want('b', 'cel', phone)
    sizes.take('b', 'cel')
    expect(sizes.leave('a', 'cel')).toEqual({ ...pc, holder: DESKTOP })
    expect(sizes.viewers('a')).toEqual([DESKTOP])
    expect(sizes.leaveAll('cel')).toEqual([['b', { ...pc, holder: DESKTOP }]])
  })

  it('celular que não manda sai sem mexer no tamanho', () => {
    const sizes = new TerminalSizes()
    sizes.want('t', DESKTOP, pc)
    sizes.want('t', 'cel', phone)
    expect(sizes.leave('t', 'cel')).toBeNull()
    expect(sizes.current('t')).toEqual({ ...pc, holder: DESKTOP })
  })

  it('aba aberta pelo celular sem o PC olhar fica sem dono quando ele sai', () => {
    const sizes = new TerminalSizes()
    expect(sizes.want('t', 'cel', phone)).toEqual({ ...phone, holder: 'cel' })
    expect(sizes.leave('t', 'cel')).toBeNull()
    expect(sizes.holder('t')).toBeNull()
    expect(sizes.want('t', DESKTOP, pc)).toEqual({ ...pc, holder: DESKTOP })
  })

  it('o PC tem preferência quando quem manda sai, mesmo tendo chegado depois', () => {
    const sizes = new TerminalSizes()
    sizes.want('t', 'cel1', phone)
    sizes.want('t', DESKTOP, pc)
    sizes.want('t', 'cel2', { cols: 50, rows: 28 })
    sizes.take('t', 'cel2')
    expect(sizes.leave('t', 'cel2')).toEqual({ ...pc, holder: DESKTOP })
  })

  it('com dois celulares, o tamanho passa para o outro que ainda está olhando', () => {
    const sizes = new TerminalSizes()
    sizes.want('t', 'cel1', phone)
    sizes.want('t', 'cel2', { cols: 50, rows: 28 })
    sizes.take('t', 'cel2')
    expect(sizes.leave('t', 'cel2')).toEqual({ ...phone, holder: 'cel1' })
  })
})
