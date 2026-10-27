import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Terminals } from '../src/main/terminals'

const opened: Terminals[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const terminals of opened.splice(0)) terminals.killAll()
})

// Programa no lugar do agente: liga a colagem (bracketed paste), como o Claude, o Codex e o PowerShell, e quando chega
// o marcador conta o que veio antes dele em cada colagem e se terminou com Enter.
const END = '@@FIM@@'
const PASTES_PROGRAM = [
  'process.stdin.setRawMode(true)',
  "let received = ''",
  "process.stdin.on('data', (chunk) => {",
  '  received += chunk.toString()',
  `  const end = received.indexOf(${JSON.stringify(END)})`,
  '  if (end < 0) return',
  '  const before = received.slice(0, end)',
  '  const pastes = [...before.matchAll(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/g)].map((match) => match[1])',
  "  process.stdout.write(`COLAGENS=${JSON.stringify({ pastes, enter: before.endsWith('\\r') })};`)",
  '})',
  "process.stdout.write('\\x1b[?2004hPRONTO;')"
].join('\n')

async function open(program: string, cols: number): Promise<{ terminals: Terminals; id: string; output: () => string }> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-submit-')))
  const script = join(dir, 'programa.cjs')
  writeFileSync(script, program, 'utf8')
  let output = ''
  const terminals = new Terminals({ onData: (_id, data) => { output += data }, onExit: () => {} }, process.execPath, [script])
  opened.push(terminals)
  terminals.setMirroring(true)
  const id = randomUUID()
  terminals.spawn(id, dir, cols, 10)
  await expect.poll(() => output.includes('PRONTO;'), { timeout: 15000 }).toBe(true)
  // Espera a cópia do terminal ler o pedido de colagem (?2004h); antes disso o envio iria como texto solto.
  await terminals.snapshot(id)
  return { terminals, id, output: () => output }
}

async function pastesFor(agent: 'claude' | undefined, text = 'o que é isso?'): Promise<{ pastes: string[]; enter: boolean }> {
  const { terminals, id, output } = await open(PASTES_PROGRAM, 200)
  terminals.submit(id, text, agent, ['C:\\temp\\print-1.png', 'C:\\temp\\print-2.png'])
  // Timers vencem na ordem do prazo e o terminal entrega na ordem em que recebeu: com prazo maior que o de qualquer
  // colagem ou Enter do submit, o marcador chega depois de tudo, por mais lenta que a máquina esteja.
  setTimeout(() => terminals.write(id, END), 3000)
  await expect.poll(() => output().includes('COLAGENS='), { timeout: 30_000, interval: 50 }).toBe(true)
  return JSON.parse(/COLAGENS=(\{.*?\});/.exec(output())![1]!)
}

// Quando o Enter é escrito no terminal, em ms depois do envio. Timers falsos: a máquina carregada não muda a conta.
async function enterDelay(agent: 'claude' | 'codex'): Promise<number> {
  const { terminals, id } = await open("process.stdin.setRawMode(true); process.stdout.write('PRONTO;')", 80)
  const proc = (terminals as unknown as { sessions: Map<string, { write(data: string): void }> }).sessions.get(id)!
  const write = vi.spyOn(proc, 'write')
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  terminals.submit(id, 'oi agente', agent)
  for (let ms = 0; ms <= 1000; ms += 10) {
    if (write.mock.calls.some(([data]) => data === '\r')) return ms
    vi.advanceTimersByTime(10)
  }
  throw new Error('o Enter não foi escrito em 1 s')
}

it('no agente o texto vem primeiro e cada imagem chega numa colagem só com o caminho, como o Ctrl+V do PC', async () => {
  expect(await pastesFor('claude')).toEqual({ pastes: ['o que é isso?', 'C:\\temp\\print-1.png', 'C:\\temp\\print-2.png'], enter: true })
})

it('no terminal comum o caminho vai depois do texto, para o shell não executar o print', async () => {
  expect(await pastesFor(undefined)).toEqual({ pastes: ['o que é isso? C:\\temp\\print-1.png C:\\temp\\print-2.png'], enter: true })
})

it('só imagem num terminal comum cola o caminho sem apertar Enter, para não executar o arquivo', async () => {
  for (const text of ['', '   ']) {
    expect(await pastesFor(undefined, text)).toEqual({ pastes: ['C:\\temp\\print-1.png C:\\temp\\print-2.png'], enter: false })
  }
})

it('no Codex o Enter espera o bastante para não virar quebra de linha da colagem', async () => {
  expect(await enterDelay('codex')).toBeGreaterThanOrEqual(400)
})

it('no Claude o Enter continua chegando logo depois do texto', async () => {
  expect(await enterDelay('claude')).toBeLessThan(400)
})
