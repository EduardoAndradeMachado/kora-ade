import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Terminals } from '../src/main/terminals'

const opened: Terminals[] = []
afterEach(() => { for (const terminals of opened.splice(0)) terminals.killAll() })

// Programa no lugar do agente: avisa quando o Enter chega. O tempo é medido do envio até esse aviso, que só cresce
// com a máquina carregada; medido do primeiro caractere, um texto entregue com atraso encolhia o intervalo.
async function enterGap(agent?: 'claude' | 'codex'): Promise<number> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-submit-')))
  const script = join(dir, 'gap.cjs')
  writeFileSync(script, [
    'process.stdin.setRawMode(true)',
    "process.stdin.on('data', (chunk) => { if (chunk.toString().includes('\\r')) process.stdout.write('ENTER;') })",
    "process.stdout.write('PRONTO;')"
  ].join('\n'), 'utf8')
  let output = ''
  const terminals = new Terminals({ onData: (_id, data) => { output += data }, onExit: () => {} }, process.execPath, [script])
  opened.push(terminals)
  const id = randomUUID()
  terminals.spawn(id, dir, 80, 10)
  await expect.poll(() => output.includes('PRONTO;'), { timeout: 15000 }).toBe(true)
  const start = performance.now()
  terminals.submit(id, 'oi agente', agent)
  await expect.poll(() => output.includes('ENTER;'), { timeout: 5000, interval: 10 }).toBe(true)
  return performance.now() - start
}

// Programa que liga a colagem (bracketed paste), como o Claude, o Codex e o PowerShell, e conta o que chegou em cada uma.
async function pastesFor(agent: 'claude' | undefined, text = 'o que é isso?'): Promise<{ pastes: string[]; enter: boolean; received: string }> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-pastes-')))
  const script = join(dir, 'pastes.cjs')
  writeFileSync(script, [
    'process.stdin.setRawMode(true)',
    "let received = ''",
    "process.stdin.on('data', (chunk) => {",
    '  received += chunk.toString()',
    '  const pastes = [...received.matchAll(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/g)].map((match) => match[1])',
    "  process.stdout.write(`COLAGENS=${JSON.stringify({ pastes, enter: received.endsWith('\\r') })};`)",
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
  // Espera a cópia do terminal ler o pedido de colagem (?2004h); antes disso o envio iria como texto solto.
  await terminals.snapshot(id)
  terminals.submit(id, text, agent, ['C:\\temp\\print-1.png', 'C:\\temp\\print-2.png'])
  // Espera as colagens e o Enter (ou a falta dele) chegarem: a última resposta do programa é a que vale.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const reports = [...output.matchAll(/COLAGENS=(\{.*?\});/g)]
  expect(reports.length).toBeGreaterThan(0)
  return { ...JSON.parse(reports.at(-1)![1]!), received: output }
}

it('no agente o texto vem primeiro e cada imagem chega numa colagem só com o caminho, como o Ctrl+V do PC', async () => {
  expect(await pastesFor('claude')).toMatchObject({ pastes: ['o que é isso?', 'C:\\temp\\print-1.png', 'C:\\temp\\print-2.png'], enter: true })
})

it('no terminal comum o caminho vai depois do texto, para o shell não executar o print', async () => {
  expect(await pastesFor(undefined)).toMatchObject({ pastes: ['o que é isso? C:\\temp\\print-1.png C:\\temp\\print-2.png'], enter: true })
})

it('só imagem num terminal comum cola o caminho sem apertar Enter, para não executar o arquivo', async () => {
  for (const text of ['', '   ']) {
    expect(await pastesFor(undefined, text)).toMatchObject({ pastes: ['C:\\temp\\print-1.png C:\\temp\\print-2.png'], enter: false })
  }
})

it('no Codex o Enter espera o bastante para não virar quebra de linha da colagem', async () => {
  expect(await enterGap('codex')).toBeGreaterThanOrEqual(400)
})

it('no Claude o Enter continua chegando logo depois do texto', async () => {
  expect(await enterGap('claude')).toBeLessThan(400)
})
