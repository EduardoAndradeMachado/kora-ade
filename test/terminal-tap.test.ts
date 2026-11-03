import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { targetAt } from '../src/renderer/src/mobile/terminalTap'

// Terminal de verdade (o mesmo buffer do xterm do celular), sem tela: o texto passa pelo parser e pela quebra de linha.
async function screen(cols: number, text: string): Promise<Terminal> {
  const term = new Terminal({ cols, rows: 10, allowProposedApi: true })
  await new Promise<void>((done) => term.write(text, done))
  return term
}
const tap = (term: Terminal, x: number, y: number) => targetAt(term.buffer.active, term.cols, x, y)

describe('toque em link no terminal do celular', () => {
  it('URL quebrada em duas linhas abre inteira, tocando em qualquer uma delas', async () => {
    const term = await screen(20, 'veja https://exemplo.com.br/docs/pagina.')
    expect(tap(term, 8, 0)).toEqual({ kind: 'url', text: 'https://exemplo.com.br/docs/pagina' })
    expect(tap(term, 5, 1)).toEqual({ kind: 'url', text: 'https://exemplo.com.br/docs/pagina' })
  })

  it('depois de caractere largo (duas células), o toque abre o link da coluna tocada, não o vizinho', async () => {
    // 日本語文字化 ocupa 12 células e 6 caracteres: a.ts fica na coluna 13 e b.ts na 18.
    const term = await screen(80, '日本語文字化 a.ts b.ts')
    expect(tap(term, 13, 0)).toEqual({ kind: 'path', text: 'a.ts' })
    expect(tap(term, 18, 0)).toEqual({ kind: 'path', text: 'b.ts' })
  })

  it('texto comum e toque longe do link não abrem nada', async () => {
    const term = await screen(80, 'nada para abrir aqui            README.md')
    expect(tap(term, 2, 0)).toBeNull()
    expect(tap(term, 26, 0)).toBeNull()
    expect(tap(term, 31, 0)).toEqual({ kind: 'path', text: 'README.md' })
  })

  it('arquivo dentro de uma URL é da URL, não do projeto', async () => {
    const term = await screen(80, 'https://site.com/app.js')
    expect(tap(term, 19, 0)).toEqual({ kind: 'url', text: 'https://site.com/app.js' })
  })
})
