import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { lineAtOffset, lineForTop, markdownBlocks, offsetForLine, scrollPoints, topForLine } from '../src/renderer/src/lib/markdown-scroll'

describe('markdownBlocks', () => {
  it('cada bloco sai com a linha (a partir de 0) em que começa no texto', () => {
    const source = [
      '# Título', // 0
      '', // 1
      'parágrafo', // 2
      'continua', // 3
      '', // 4
      '[ref]: https://example.com', // 5
      '', // 6
      '- a', // 7
      '- b', // 8
      '', // 9
      '```js', // 10
      'x', // 11
      '```', // 12
      '| a | b |', // 13
      '|---|---|', // 14
      '| 1 | 2 |', // 15
      '', // 16
      '', // 17
      'fim [ref]' // 18
    ].join('\r\n')
    const blocks = markdownBlocks(source)
    expect(blocks.map((b) => b.line)).toEqual([0, 2, 7, 10, 13, 18])
    expect(blocks[0]?.html).toContain('<h1')
    expect(blocks[3]?.html).toContain('<pre>')
    // A definição de link não vira bloco, mas continua valendo para o link do fim.
    expect(blocks[5]?.html).toContain('href="https://example.com"')
  })

  it('juntos, os blocos dão o mesmo HTML que o documento inteiro', () => {
    const source = '# A\n\ntexto *b* [r]\n\n[r]: /x\n\n<details>\n\n- 1\n- 2\n\n</details>\n\n> c\n\n| a |\n|---|\n| 1 |\n\n---\n\n```mermaid\ngraph TD\n```\n'
    expect(markdownBlocks(source).map((b) => b.html).join('')).toBe(marked.parse(source, { async: false, gfm: true }))
  })

  it('HTML que abre num bloco e fecha em outro fica em blocos separados, na ordem', () => {
    const blocks = markdownBlocks('<details>\n\n**dentro**\n\n</details>\n')
    expect(blocks.map((b) => [b.line, b.html.trim()])).toEqual([
      [0, '<details>'],
      [2, '<p><strong>dentro</strong></p>'],
      [4, '</details>']
    ])
  })
})

describe('scrollPoints e interpolação', () => {
  // Blocos nas linhas 0, 10 e 20, a 0, 100 e 400 px; 30 linhas e 1000 px no total.
  const points = scrollPoints(
    [
      { line: 0, top: 20 },
      { line: 10, top: 100 },
      { line: 20, top: 400 }
    ],
    30,
    1000
  )

  it('o começo é sempre (0, 0) e o fim é (total de linhas, altura)', () => {
    expect(points).toEqual([
      { line: 0, top: 0 },
      { line: 10, top: 100 },
      { line: 20, top: 400 },
      { line: 30, top: 1000 }
    ])
  })

  it('linha → altura interpola dentro do bloco, até o próximo', () => {
    expect(topForLine(points, 10)).toBe(100)
    expect(topForLine(points, 15)).toBe(250)
    expect(topForLine(points, 25)).toBe(700)
    expect(topForLine(points, 99)).toBe(1000)
    expect(topForLine(points, -5)).toBe(0)
    expect(lineForTop(points, -40)).toBe(0)
  })

  it('altura → linha é o caminho de volta', () => {
    expect(lineForTop(points, 250)).toBe(15)
    expect(lineForTop(points, 700)).toBe(25)
    expect(lineForTop(points, 0)).toBe(0)
    for (const line of [3, 12.5, 19, 27]) expect(lineForTop(points, topForLine(points, line))).toBeCloseTo(line)
  })

  it('bloco fora de ordem (sem altura ainda, ou acima do anterior) fica de fora', () => {
    const cleaned = scrollPoints(
      [
        { line: 5, top: 200 },
        { line: 8, top: 0 },
        { line: 8, top: 250 },
        { line: 12, top: 300 }
      ],
      20,
      500
    )
    expect(cleaned).toEqual([
      { line: 0, top: 0 },
      { line: 5, top: 200 },
      { line: 8, top: 250 },
      { line: 12, top: 300 },
      { line: 20, top: 500 }
    ])
  })
})

describe('linha do editor ↔ deslocamento', () => {
  // Linhas de 20 px, a 3 quebrada em 3 linhas visuais (60 px): tops 0, 20, 40, 100, 120.
  const tops = [0, 20, 40, 100, 120]
  const topOf = (n: number): number => tops[n - 1] ?? 0

  it('a linha no topo, fracionária, conta a linha quebrada pela altura dela', () => {
    expect(lineAtOffset(5, topOf, 0)).toBe(0)
    expect(lineAtOffset(5, topOf, 30)).toBe(1.5)
    expect(lineAtOffset(5, topOf, 70)).toBe(2.5)
    expect(lineAtOffset(5, topOf, 100)).toBe(3)
    expect(lineAtOffset(5, topOf, 500)).toBe(4)
  })

  it('o deslocamento de uma linha fracionária é o caminho de volta', () => {
    expect(offsetForLine(5, topOf, 2.5)).toBe(70)
    expect(offsetForLine(5, topOf, 0)).toBe(0)
    expect(offsetForLine(5, topOf, 40)).toBe(120)
    for (const offset of [0, 30, 55, 100, 110]) expect(offsetForLine(5, topOf, lineAtOffset(5, topOf, offset))).toBeCloseTo(offset)
  })
})
