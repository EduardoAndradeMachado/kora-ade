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

  // O Claude e o Codex quebram a linha eles mesmos: o pedaço de baixo não tem a marca isWrapped e vem recuado.
  it('URL cortada pelo programa na margem, sem quebra automática: abre inteira, tocando em qualquer uma das linhas', async () => {
    const first = '• Docs: https://exemplo.com/'
    const term = await screen(first.length, `${first}\r\n  docs/pagina?id=7 e mais`)
    expect(term.buffer.active.getLine(1)!.isWrapped).toBe(false)
    expect(tap(term, 10, 0)).toEqual({ kind: 'url', text: 'https://exemplo.com/docs/pagina?id=7' })
    expect(tap(term, 4, 1)).toEqual({ kind: 'url', text: 'https://exemplo.com/docs/pagina?id=7' })
    expect(tap(term, 20, 1)).toBeNull()
  })

  it('caminho cortado na margem abre inteiro e leva junto o caminho lido só na linha tocada', async () => {
    const first = 'erro em src/componentes/'
    const term = await screen(first.length, `${first}\r\n  Botao.tsx:12 aqui`)
    expect(tap(term, 4, 1)).toEqual({ kind: 'path', text: 'src/componentes/Botao.tsx:12', alone: 'Botao.tsx:12' })
    expect(tap(term, 12, 0)).toMatchObject({ kind: 'path', text: 'src/componentes/Botao.tsx:12' })
  })

  it('como chega pelo ConPTY: linha cheia sem quebra, e a de baixo vira quebra automática com o recuo do programa', async () => {
    const first = 'veja      src/componentes/'
    const term = await screen(first.length, `${first}  Botao.tsx:3 fim`)
    expect(term.buffer.active.getLine(1)!.isWrapped).toBe(true)
    expect(tap(term, 4, 1)).toEqual({ kind: 'path', text: 'src/componentes/Botao.tsx:3', alone: 'Botao.tsx:3' })
    const url = 'docs: https://exemplo.com/a/'
    const web = await screen(url.length, `${url}  b?id=7`)
    expect(tap(web, 3, 1)).toEqual({ kind: 'url', text: 'https://exemplo.com/a/b?id=7' })
  })

  it('frase que encosta na margem não cola na linha de baixo', async () => {
    const first = 'abra https://site.com/a'
    const term = await screen(first.length, `${first}\r\ne depois feche`)
    expect(tap(term, 10, 0)).toEqual({ kind: 'url', text: 'https://site.com/a' })
    const short = await screen(40, 'ver https://a.com/x/\r\ndocs/y')
    expect(tap(short, 8, 0), 'linha que não chega à margem não foi cortada').toEqual({ kind: 'url', text: 'https://a.com/x/' })
  })

  it('dois caminhos, um na margem e outro no começo da linha de baixo: o de cada linha vai em alone', async () => {
    const path = 'veja o README.md'
    const term = await screen(path.length, `${path}\r\ndocs/guia.md`)
    expect(tap(term, 12, 0)).toEqual({ kind: 'path', text: 'README.mddocs/guia.md', alone: 'README.md' })
    expect(tap(term, 3, 1)).toEqual({ kind: 'path', text: 'README.mddocs/guia.md', alone: 'docs/guia.md' })
  })

  it('moldura de tela embaixo de uma URL na margem não vira pedaço dela', async () => {
    const first = 'ver https://a.com/x/'
    const term = await screen(first.length, `${first}\r\n${'─'.repeat(first.length)}`)
    expect(tap(term, 8, 0)).toEqual({ kind: 'url', text: 'https://a.com/x/' })
  })

  it('arquivo dentro de uma URL é da URL, não do projeto', async () => {
    const term = await screen(80, 'https://site.com/app.js')
    expect(tap(term, 19, 0)).toEqual({ kind: 'url', text: 'https://site.com/app.js' })
  })
})
