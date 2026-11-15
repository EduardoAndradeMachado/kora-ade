import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Terminals } from '../src/main/terminals'
import { reattachPlan } from '../src/main/terminal-reattach'
import { TerminalBus } from '../src/shared/terminal-bus'
import { SnapshotGate } from '../src/shared/terminal-replay'

const opened: Terminals[] = []
afterEach(() => {
  for (const terminals of opened.splice(0)) terminals.killAll()
})

// Mesma configuração de teclado da janela (TerminalView): sem kittyKeyboard o xterm ignora as flags.
const screen = (cols: number, rows: number): Terminal =>
  new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })

const settle = (term: Terminal): Promise<void> => new Promise((resolve) => term.write('', resolve))

function lines(term: Terminal): string[] {
  const buffer = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buffer.length; y++) out.push(buffer.getLine(y)?.translateToString(true) ?? '')
  while (out.length > 0 && out.at(-1) === '') out.pop()
  return out
}

// A resposta do próprio xterm à consulta "CSI ? u": as flags do teclado kitty que ele usaria para codificar as teclas.
async function kittyFlags(term: Terminal): Promise<string> {
  let reply = ''
  const off = term.onData((data) => (reply += data))
  await new Promise<void>((resolve) => term.write('\x1b[?u', resolve))
  off.dispose()
  return JSON.stringify(reply)
}

function script(name: string, source: string[]): { dir: string; file: string } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-reattach-')))
  const file = join(dir, name)
  writeFileSync(file, source.join('\n'), 'utf8')
  return { dir, file }
}

async function poll(check: () => boolean, ms = 20_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('tempo esgotado esperando a saída do terminal')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('reattachPlan', () => {
  it('liga de volta os ptys que têm aba no estado e separa os que ficaram sem aba', () => {
    expect(reattachPlan(['a', 'fechada', 'b'], [{ id: 'b' }, { id: 'a' }, { id: 'adormecida' }])).toEqual({
      attach: ['a', 'b'],
      orphans: ['fechada']
    })
  })

  it('sem ptys vivos (primeira abertura do app) não há nada a ligar nem a encerrar', () => {
    expect(reattachPlan([], [{ id: 'a' }])).toEqual({ attach: [], orphans: [] })
  })

  it('estado sem abas: todo pty vivo é órfão', () => {
    expect(reattachPlan(['a', 'b'], [])).toEqual({ attach: [], orphans: ['a', 'b'] })
  })
})

describe('reconexão de uma interface recarregada ao pty vivo', () => {
  it('a tela reconstruída pela foto do main e a saída seguinte fica igual à de quem viu tudo, sem perder nem repetir linhas', async () => {
    // Rajadas rápidas: a foto é tirada com saída ainda chegando e ainda por interpretar no espelho do main.
    const { dir, file } = script('rajadas.cjs', [
      'let n = 0',
      'const tick = setInterval(() => {',
      "  let out = ''",
      '  for (let i = 0; i < 7 && n < 2500; i++) out += `linha ${++n} ${"x".repeat(n % 50)}\\r\\n`',
      '  process.stdout.write(out)',
      "  if (n >= 2500) { clearInterval(tick); process.stdout.write('FIM\\r\\n') }",
      '}, 2)',
      'setInterval(() => {}, 1000)'
    ])
    const cols = 100
    const rows = 30
    // A janela que nunca caiu: recebe todo pedaço, na ordem, desde o começo.
    const witness = screen(cols, rows)
    let witnessText = ''
    // Cada janela recarregada só passa a ouvir o main a partir de quando nasce: o que saiu antes (e durante a queda)
    // só existe no espelho do main.
    const reloaded: { bus: TerminalBus; term: Terminal }[] = []
    const terminals = new Terminals(
      {
        onData: (tabId, data, sequence) => {
          witness.write(data)
          witnessText += data
          // No Electron a saída chega à página em ordem, mas a resposta da foto pode passar na frente dela: a
          // entrega com atraso fixo (fila) reproduz isso.
          for (const page of reloaded) setTimeout(() => page.bus.push(tabId, data, sequence), 8)
        },
        onExit: () => {}
      },
      process.execPath,
      [file]
    )
    opened.push(terminals)
    const id = randomUUID()
    terminals.spawn(id, dir, cols, rows)

    // Várias recargas no meio da rajada: a corrida entre a foto e a saída que chega não acontece em toda foto.
    for (let reload = 0; reload < 14; reload++) {
      await new Promise((r) => setTimeout(r, 25 + reload * 5))
      const page = { bus: new TerminalBus(), term: screen(80, 24) }
      reloaded.push(page)
      await new Promise((r) => setTimeout(r, 15))
      // O que o TerminalView faz ao montar: inscreve, enfileira, pede a foto e solta a fila depois dela.
      const gate = new SnapshotGate((data) => page.term.write(data))
      page.bus.subscribe(id, (data, sequence) => gate.push(data, sequence))
      const snapshot = await terminals.snapshot(id)
      expect(snapshot).not.toBeNull()
      page.term.resize(snapshot!.cols, snapshot!.rows)
      gate.release(snapshot)
    }

    await poll(() => witnessText.includes('FIM'))
    await new Promise((r) => setTimeout(r, 300))
    await settle(witness)
    const expected = lines(witness)
    expect(expected.filter((line) => line.startsWith('linha '))).toHaveLength(2500)
    for (const [index, page] of reloaded.entries()) {
      await settle(page.term)
      expect(lines(page.term), `janela recarregada ${index + 1}`).toEqual(expected)
    }
  })

  it('as flags do teclado kitty voltam com a tela: Shift+Enter continua sendo quebra de linha no Claude Code', async () => {
    // O Claude Code liga o protocolo com CSI >5u ao abrir, empilhando sobre o que havia: aqui um programa de fora
    // que já tinha pedido o nível 1.
    const { dir, file } = script('kitty.cjs', ["process.stdout.write('\\x1b[>1u\\x1b[>5uPRONTO\\r\\n')", 'setInterval(() => {}, 1000)'])
    let output = ''
    const terminals = new Terminals({ onData: (_id, data) => (output += data), onExit: () => {} }, process.execPath, [file])
    opened.push(terminals)
    const id = randomUUID()
    terminals.spawn(id, dir, 80, 24)
    await poll(() => output.includes('PRONTO'))

    const page = screen(80, 24)
    page.write((await terminals.snapshot(id))!.data)
    expect(await kittyFlags(page)).toBe(JSON.stringify('\x1b[?5u'))
    // Ao sair, o Claude desempilha: volta ao que havia antes dele, como na janela que nunca caiu.
    page.write('\x1b[<u')
    expect(await kittyFlags(page)).toBe(JSON.stringify('\x1b[?1u'))
    page.write('\x1b[<u')
    expect(await kittyFlags(page)).toBe(JSON.stringify('\x1b[?0u'))
  })

  it('na tela alternativa, cada tela volta com as suas flags: sair dela devolve as da tela normal', async () => {
    const { dir, file } = script('kitty-alt.cjs', [
      "process.stdout.write('\\x1b[>5unormal\\r\\n')",
      "setTimeout(() => process.stdout.write('\\x1b[?1049h\\x1b[>1uALTERNATIVA'), 300)",
      'setInterval(() => {}, 1000)'
    ])
    let output = ''
    const terminals = new Terminals({ onData: (_id, data) => (output += data), onExit: () => {} }, process.execPath, [file])
    opened.push(terminals)
    const id = randomUUID()
    terminals.spawn(id, dir, 80, 24)
    await poll(() => output.includes('ALTERNATIVA'))

    const page = screen(80, 24)
    page.write((await terminals.snapshot(id))!.data)
    await settle(page)
    expect(page.buffer.active.type).toBe('alternate')
    expect(lines(page).join('\n')).toContain('ALTERNATIVA')
    expect(await kittyFlags(page)).toBe(JSON.stringify('\x1b[?1u'))
    page.write('\x1b[?1049l')
    expect(await kittyFlags(page)).toBe(JSON.stringify('\x1b[?5u'))
    expect(lines(page).join('\n')).toContain('normal')
  })
})
