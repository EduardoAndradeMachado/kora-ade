import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_TIMEOUT_MS, releaseStuckDrag, type DragTarget } from '../src/main/stuck-drag'

afterEach(() => vi.useRealTimers())

interface Fake extends DragTarget {
  calls: string[]
  answer: () => void
}

function fakeContents(opts: { attached?: boolean; destroyed?: boolean } = {}): Fake {
  let attached = opts.attached ?? false
  const pending: (() => void)[] = []
  const fake: Fake = {
    calls: [],
    answer: () => pending.shift()?.(),
    isDestroyed: () => opts.destroyed ?? false,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        fake.calls.push('attach')
        attached = true
      },
      detach: () => {
        fake.calls.push('detach')
        attached = false
      },
      sendCommand: (method, params) => {
        fake.calls.push(`${method}:${String(params?.['type'])}`)
        return new Promise<void>((resolve) => pending.push(resolve))
      }
    }
  }
  return fake
}

describe('destravar a interface presa num arrasto', () => {
  it('anexa o depurador, cancela o arrasto e solta o depurador', async () => {
    const contents = fakeContents()
    const release = releaseStuckDrag(contents)
    contents.answer()
    await release
    expect(contents.calls).toEqual(['attach', 'Input.dispatchDragEvent:dragCancel', 'detach'])
  })

  it('pedidos seguidos compartilham o mesmo cancelamento em andamento', async () => {
    const contents = fakeContents()
    const first = releaseStuckDrag(contents)
    const second = releaseStuckDrag(contents)
    contents.answer()
    await Promise.all([first, second])
    expect(contents.calls).toEqual(['attach', 'Input.dispatchDragEvent:dragCancel', 'detach'])
  })

  it('página que não responde não segura os próximos pedidos: o prazo solta o depurador e o pedido seguinte manda de novo', async () => {
    vi.useFakeTimers()
    const contents = fakeContents()
    const stuck = releaseStuckDrag(contents)
    const failed = expect(stuck).rejects.toThrow(/não respondeu/)
    await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS)
    await failed
    expect(contents.calls).toEqual(['attach', 'Input.dispatchDragEvent:dragCancel', 'detach'])

    const again = releaseStuckDrag(contents)
    contents.answer()
    contents.answer()
    await again
    expect(contents.calls.slice(3)).toEqual(['attach', 'Input.dispatchDragEvent:dragCancel', 'detach'])
  })

  it('depurador que já estava anexado por outro fica anexado', async () => {
    const contents = fakeContents({ attached: true })
    const release = releaseStuckDrag(contents)
    contents.answer()
    await release
    expect(contents.calls).toEqual(['Input.dispatchDragEvent:dragCancel'])
  })

  it('janela já destruída não é tocada', async () => {
    const contents = fakeContents({ destroyed: true })
    await releaseStuckDrag(contents)
    expect(contents.calls).toEqual([])
  })
})
