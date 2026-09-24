import { describe, expect, it } from 'vitest'
import { finishedUnseen, MIN_WORK_MS, type Transition } from '../src/renderer/src/lib/alerts'

const base: Transition = { previous: 'working', next: 'waiting', workingSince: 0, now: MIN_WORK_MS, watching: false }

describe('aviso de sessão parada', () => {
  it('avisa quando para depois de trabalhar o tempo mínimo e você não está olhando', () => {
    expect(finishedUnseen(base)).toBe(true)
  })

  it('não avisa para a aba que você está olhando', () => {
    expect(finishedUnseen({ ...base, watching: true })).toBe(false)
  })

  it('resposta curta não avisa', () => {
    expect(finishedUnseen({ ...base, now: MIN_WORK_MS - 1 })).toBe(false)
  })

  it('só a passagem de trabalhando para esperando avisa', () => {
    expect(finishedUnseen({ ...base, previous: 'waiting' })).toBe(false)
    expect(finishedUnseen({ ...base, previous: undefined })).toBe(false)
    expect(finishedUnseen({ ...base, next: 'working' })).toBe(false)
    expect(finishedUnseen({ ...base, next: null })).toBe(false)
  })

  it('sem o início do trabalho registrado, não avisa', () => {
    expect(finishedUnseen({ ...base, workingSince: null })).toBe(false)
  })
})
