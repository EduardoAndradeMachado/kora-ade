import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminals } from '../src/main/terminals'

const opened: Terminals[] = []
afterEach(() => { for (const terminals of opened.splice(0)) terminals.killAll() })

// A janela do PC e a do celular desenham com Unicode 11, em que emoji ocupa duas colunas.
async function asDrawn(data: string): Promise<string> {
  const screen = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
  screen.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon)
  screen.unicode.activeVersion = '11'
  await new Promise<void>((resolve) => screen.write(data, resolve))
  return screen.buffer.active.getLine(0)?.translateToString(true) ?? ''
}

it('a foto que o celular recebe guarda o emoji no lugar em que o PC o desenha', async () => {
  // O Claude atualiza só um pedaço da linha (o spinner, um contador) e o ConPTY repassa isso como "vá para a
  // coluna X": a cópia do main precisa contar as colunas do emoji igual ao PC, ou escreve no lugar errado.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-emoji-')))
  const script = join(dir, 'emoji.cjs')
  writeFileSync(script, [
    "process.stdout.write('\\u{1F600}\\u{1F600}abcdefghijklmnop')",
    "setTimeout(() => process.stdout.write('\\x1b[7GX'), 400)",
    "setTimeout(() => process.stdout.write('\\r\\nPRONTO'), 800)",
    'setInterval(() => {}, 1000)'
  ].join('\n'), 'utf8')
  let output = ''
  const terminals = new Terminals({ onData: (_id, data) => { output += data }, onExit: () => {} }, process.execPath, [script])
  opened.push(terminals)
  terminals.setMirroring(true)
  const id = randomUUID()
  terminals.spawn(id, dir, 40, 5)
  await expect.poll(() => output.includes('PRONTO'), { timeout: 15000 }).toBe(true)
  const snapshot = await terminals.snapshot(id)
  expect(await asDrawn(output)).toBe('😀😀abXdefghijklmnop')
  expect(await asDrawn(snapshot!.data)).toBe('😀😀abXdefghijklmnop')
})
