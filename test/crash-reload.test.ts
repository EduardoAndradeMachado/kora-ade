import { describe, expect, it } from 'vitest'
import { decideCrashReload } from '../src/main/crash-reload'

// Uma sequência de quedas, cada uma com a decisão alimentando a próxima, como o main faz.
function crashes(reason: string, times: number[]): boolean[] {
  let recent: number[] = []
  return times.map((now) => {
    const decision = decideCrashReload(reason, recent, now)
    recent = decision.recent
    return decision.action === 'reload'
  })
}

describe('interface que caiu recarrega sozinha', () => {
  it('recarrega até 3 vezes no mesmo minuto; a quarta fica sem recarregar', () => {
    expect(crashes('oom', [0, 10_000, 20_000, 30_000, 59_000])).toEqual([true, true, true, false, false])
  })

  it('passado um minuto da mais antiga, volta a recarregar', () => {
    expect(crashes('crashed', [0, 1_000, 2_000, 3_000, 60_000, 61_500])).toEqual([true, true, true, false, true, true])
  })

  it('queda recusada não conta como recarregamento', () => {
    // Se a recusa entrasse na conta, a queda dos 60,5 s ainda veria três na janela.
    expect(crashes('killed', [0, 1_000, 2_000, 30_000, 40_000, 60_500])).toEqual([true, true, true, false, false, true])
  })

  it('só falta de memória, travamento e processo morto; fechar a janela ou não conseguir abrir não recarrega', () => {
    for (const reason of ['crashed', 'oom', 'killed']) expect(crashes(reason, [0]), reason).toEqual([true])
    for (const reason of ['clean-exit', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction']) {
      expect(decideCrashReload(reason, [], 0).action, reason).toBe('ignore')
    }
  })

  it('no limite, desiste (e o main registra), diferente de ignorar a janela fechando', () => {
    expect(decideCrashReload('oom', [0, 1_000, 2_000], 3_000).action).toBe('give-up')
    expect(decideCrashReload('clean-exit', [0, 1_000, 2_000], 3_000).action).toBe('ignore')
  })
})
