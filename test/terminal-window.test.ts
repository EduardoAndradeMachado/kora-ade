import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { firstVisibleRow } from '../src/renderer/src/mobile/terminalWindow'

// Terminal de verdade (o mesmo buffer do xterm do celular), sem tela: as sequências passam pelo parser.
async function screen(rows: number, text: string): Promise<Terminal> {
  const term = new Terminal({ cols: 40, rows, scrollback: 1000, allowProposedApi: true })
  await new Promise<void>((done) => term.write(text, done))
  return term
}

// O que a pessoa vê quando cabem só `fits` linhas, e qual delas tem o cursor.
function shown(term: Terminal, fits: number): { lines: string[]; cursor: number } {
  const buffer = term.buffer.active
  const first = firstVisibleRow(buffer, term.rows, fits)
  const lines: string[] = []
  for (let row = first; row < Math.min(term.rows, first + fits); row++) lines.push(buffer.getLine(buffer.viewportY + row)!.translateToString(true).trimEnd())
  return { lines, cursor: buffer.baseY + buffer.cursorY - buffer.viewportY - first }
}

const lines = (count: number, prefix: string): string => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\r\n')

describe('recorte do terminal do celular com o teclado aberto', () => {
  it('depois de cls, o prompt no topo da tela fica à vista, e não o fim em branco', async () => {
    const term = await screen(28, `${lines(80, 'saida')}\r\n\x1b[2J\x1b[3J\x1b[HPS C:\\proj> `)
    const { lines: visible, cursor } = shown(term, 11)
    expect(visible[cursor]).toBe('PS C:\\proj>')
    expect(visible[0]).toBe('PS C:\\proj>')
  })

  it('aba nova do agente: mostra o campo dele (cursor) com o rodapé de baixo e o que cabe da resposta acima', async () => {
    const banner = lines(10, 'boas-vindas')
    const term = await screen(28, `${banner}\r\n╭────────╮\r\n│ >      │\r\n╰────────╯\r\n? atalhos\r\nmodo normal\x1b[12;5H`)
    const { lines: visible, cursor } = shown(term, 8)
    expect(visible[cursor]).toBe('│ >      │')
    expect(visible.at(-1), 'o rodapé abaixo do campo entra').toBe('modo normal')
    expect(visible).toContain('boas-vindas 10')
    expect(visible, 'nenhuma linha em branco do fim da tela toma o lugar do conteúdo').not.toContain('')
  })

  it('tela cheia de saída com o prompt embaixo: mostra o fim, como antes', async () => {
    const term = await screen(28, `${lines(200, 'linha')}\r\nPS C:\\proj> `)
    const { lines: visible, cursor } = shown(term, 11)
    expect(visible[cursor]).toBe('PS C:\\proj>')
    expect(visible.at(-1)).toBe('PS C:\\proj>')
    expect(visible[0]).toBe('linha 191')
  })

  it('tela alternativa toda escrita com o cursor no alto: o cursor fica à vista mesmo sem caber até o rodapé', async () => {
    const full = Array.from({ length: 28 }, (_, i) => `\x1b[${i + 1};1Htui ${i + 1}`).join('')
    const term = await screen(28, `${lines(40, 'shell')}\r\n\x1b[?1049h\x1b[2J${full}\x1b[6;1H\x1b[2K> pergunta`)
    expect(term.buffer.active.type).toBe('alternate')
    const { lines: visible, cursor } = shown(term, 11)
    expect(visible[cursor]).toBe('> pergunta')
    expect(cursor).toBeGreaterThanOrEqual(0)
    expect(cursor).toBeLessThan(11)
  })

  it('tela alternativa com o campo embaixo e o rodapé de status: os dois aparecem', async () => {
    const full = Array.from({ length: 24 }, (_, i) => `\x1b[${i + 1};1Hconversa ${i + 1}`).join('')
    const term = await screen(24, `\x1b[?1049h\x1b[2J${full}\x1b[24;1H\x1b[2Kstatus\x1b[22;1H\x1b[2K> `)
    const { lines: visible, cursor } = shown(term, 6)
    expect(visible[cursor]).toBe('>')
    expect(visible.at(-1)).toBe('status')
    expect(visible[0]).toBe('conversa 19')
  })

  it('rolado para o histórico: mostra a parte de baixo do que está sendo lido', async () => {
    const term = await screen(20, `${lines(200, 'linha')}\r\nPS> `)
    term.scrollLines(-100)
    const { lines: visible } = shown(term, 5)
    const buffer = term.buffer.active
    expect(visible.at(-1)).toBe(buffer.getLine(buffer.viewportY + 19)!.translateToString(true))
    expect(visible).not.toContain('PS>')
  })

  it('cabe tudo: começa no topo', async () => {
    const term = await screen(10, `${lines(30, 'linha')}\r\nPS> `)
    expect(firstVisibleRow(term.buffer.active, term.rows, 10)).toBe(0)
    expect(firstVisibleRow(term.buffer.active, term.rows, 40)).toBe(0)
  })
})
