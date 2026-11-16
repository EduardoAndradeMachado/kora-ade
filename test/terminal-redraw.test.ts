import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { Terminals } from '../src/main/terminals'

const opened: Terminals[] = []
afterEach(() => { for (const terminals of opened.splice(0)) terminals.killAll() })

function start(cols: number, rows: number): { terminals: Terminals; id: string; resizes: [number, number][] } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-redraw-')))
  const script = join(dir, 'idle.cjs')
  writeFileSync(script, 'setInterval(() => {}, 1000)', 'utf8')
  const terminals = new Terminals({ onData: () => {}, onExit: () => {} }, process.execPath, [script])
  opened.push(terminals)
  const id = randomUUID()
  terminals.spawn(id, dir, cols, rows)
  // O pty é o que leva o tamanho ao ConPTY e dele ao agente: é ali que a mudança tem de chegar.
  const proc = (terminals as unknown as { sessions: Map<string, IPty> }).sessions.get(id)!
  const resizes: [number, number][] = []
  const original = proc.resize.bind(proc)
  vi.spyOn(proc, 'resize').mockImplementation((c: number, r: number) => { resizes.push([c, r]); original(c, r) })
  return { terminals, id, resizes }
}

it('Redesenhar muda a altura do pty em uma linha e volta, sem mexer na largura', async () => {
  const { terminals, id, resizes } = start(44, 30)
  terminals.redraw(id)
  await expect.poll(() => resizes.length, { timeout: 2000 }).toBe(2)
  expect(resizes).toEqual([[44, 29], [44, 30]])
  expect((await terminals.snapshot(id))?.rows).toBe(30)
})

it('uma troca de tamanho no meio do Redesenhar vale no fim', async () => {
  // O PC toma a aba enquanto o celular redesenha: a volta não pode devolver o tamanho do celular.
  const { terminals, id, resizes } = start(44, 30)
  terminals.redraw(id)
  terminals.resize(id, 120, 40)
  await expect.poll(() => resizes.length, { timeout: 2000 }).toBe(3)
  expect(resizes.at(-1)).toEqual([120, 40])
  expect((await terminals.snapshot(id))?.cols).toBe(120)
})
