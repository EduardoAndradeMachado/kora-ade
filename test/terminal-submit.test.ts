import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Terminals } from '../src/main/terminals'

const opened: Terminals[] = []
afterEach(() => { for (const terminals of opened.splice(0)) terminals.killAll() })

// Programa no lugar do agente: mede quanto o Enter demora a chegar depois do primeiro caractere da mensagem.
async function enterGap(agent?: 'claude' | 'codex'): Promise<number> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-submit-')))
  const script = join(dir, 'gap.cjs')
  writeFileSync(script, [
    'process.stdin.setRawMode(true)',
    'let first = 0',
    "process.stdin.on('data', (chunk) => {",
    '  const text = chunk.toString()',
    '  if (!first && /[a-z]/.test(text)) first = Date.now()',
    "  if (first && text.includes('\\r')) process.stdout.write(`GAP=${Date.now() - first};`)",
    '})',
    "process.stdout.write('PRONTO;')"
  ].join('\n'), 'utf8')
  let output = ''
  const terminals = new Terminals({ onData: (_id, data) => { output += data }, onExit: () => {} }, process.execPath, [script])
  opened.push(terminals)
  const id = randomUUID()
  terminals.spawn(id, dir, 80, 10)
  await expect.poll(() => output.includes('PRONTO;'), { timeout: 15000 }).toBe(true)
  terminals.submit(id, 'oi agente', agent)
  await expect.poll(() => /GAP=\d+;/.test(output), { timeout: 5000 }).toBe(true)
  return Number(/GAP=(\d+);/.exec(output)![1])
}

it('cada imagem chega numa colagem só com o caminho, antes do texto, como o Ctrl+V do PC', async () => {
  // Programa que liga a colagem (bracketed paste), como o Claude e o Codex, e conta o que chegou em cada uma.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-pastes-')))
  const script = join(dir, 'pastes.cjs')
  writeFileSync(script, [
    'process.stdin.setRawMode(true)',
    "let received = ''",
    "process.stdin.on('data', (chunk) => {",
    '  received += chunk.toString()',
    "  if (!received.endsWith('\\r')) return",
    '  const pastes = [...received.matchAll(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/g)].map((match) => match[1])',
    '  process.stdout.write(`COLAGENS=${JSON.stringify(pastes)};`)',
    '})',
    "process.stdout.write('\\x1b[?2004hPRONTO;')"
  ].join('\n'), 'utf8')
  let output = ''
  const terminals = new Terminals({ onData: (_id, data) => { output += data }, onExit: () => {} }, process.execPath, [script])
  opened.push(terminals)
  terminals.setMirroring(true)
  const id = randomUUID()
  terminals.spawn(id, dir, 200, 10)
  await expect.poll(() => output.includes('PRONTO;'), { timeout: 15000 }).toBe(true)
  terminals.submit(id, 'o que é isso?', 'claude', ['C:\\temp\\print-1.png', 'C:\\temp\\print-2.png'])
  await expect.poll(() => /COLAGENS=(\[.*?\]);/.exec(output)?.[1], { timeout: 5000 }).toBeDefined()
  expect(JSON.parse(/COLAGENS=(\[.*?\]);/.exec(output)![1]!)).toEqual(['C:\\temp\\print-1.png', 'C:\\temp\\print-2.png', 'o que é isso?'])
})

it('no Codex o Enter espera o bastante para não virar quebra de linha da colagem', async () => {
  expect(await enterGap('codex')).toBeGreaterThanOrEqual(300)
})

it('no Claude o Enter continua chegando logo depois do texto', async () => {
  expect(await enterGap('claude')).toBeLessThan(250)
})
