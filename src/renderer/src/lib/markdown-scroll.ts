import { marked, type Token } from 'marked'

// Linhas contadas a partir de 0, como no texto; o Monaco conta a partir de 1.
export interface MarkdownBlock {
  line: number
  html: string
}

// Um bloco de nível superior por vez, com a linha onde ele começa no texto: é o que a rolagem do lado a lado usa
// para alinhar editor e visualização bloco a bloco. O marked troca \r\n por \n antes de separar, e o raw dos blocos
// de nível superior, juntos, refaz o texto: a linha sai da contagem das quebras.
export function markdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let line = 0
  for (const token of marked.lexer(source, { gfm: true }) as Token[]) {
    if (token.type !== 'space' && token.type !== 'def') blocks.push({ line, html: marked.parser([token], { gfm: true }) })
    line += token.raw.split('\n').length - 1
  }
  return blocks
}

export interface ScrollPoint {
  line: number
  top: number
}

// Pontos de linha → altura na visualização, do começo (0, 0) ao fim (total de linhas, altura total). Bloco fora de
// ordem (um diagrama ainda sem altura, um bloco dentro de <details> fechado) sairia da interpolação para trás: fica
// de fora.
export function scrollPoints(anchors: ScrollPoint[], lineCount: number, height: number): ScrollPoint[] {
  const points: ScrollPoint[] = [{ line: 0, top: 0 }]
  let last: ScrollPoint = { line: 0, top: 0 }
  for (const p of [...anchors, { line: lineCount, top: height }]) {
    if (p.line > last.line && p.top >= last.top) {
      points.push(p)
      last = p
    }
  }
  return points
}

function interpolate(points: ScrollPoint[], value: number, from: 'line' | 'top', to: 'line' | 'top'): number {
  let a = points[0]
  if (!a) return 0
  let b = a
  for (const p of points.slice(1)) {
    b = p
    if (p[from] > value) break
    a = p
  }
  const span = b[from] - a[from]
  const fraction = span > 0 ? Math.min(1, Math.max(0, (value - a[from]) / span)) : 0
  return a[to] + fraction * (b[to] - a[to])
}

export const topForLine = (points: ScrollPoint[], line: number): number => interpolate(points, line, 'line', 'top')
export const lineForTop = (points: ScrollPoint[], top: number): number => interpolate(points, top, 'top', 'line')

// topOf(n): altura do topo da linha n (contada a partir de 1, como o Monaco), com quebra de linha e dobras.
// Devolve a linha fracionária (a partir de 0) que está no topo da área visível.
export function lineAtOffset(lineCount: number, topOf: (n: number) => number, offset: number): number {
  if (lineCount <= 0) return 0
  let low = 1
  let high = lineCount
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (topOf(mid) <= offset) low = mid
    else high = mid - 1
  }
  const start = topOf(low)
  const next = low < lineCount ? topOf(low + 1) : start
  const fraction = next > start ? Math.min(1, Math.max(0, (offset - start) / (next - start))) : 0
  return low - 1 + fraction
}

export function offsetForLine(lineCount: number, topOf: (n: number) => number, line: number): number {
  if (lineCount <= 0) return 0
  const whole = Math.min(lineCount, Math.max(1, Math.floor(line) + 1))
  const start = topOf(whole)
  const next = whole < lineCount ? topOf(whole + 1) : start
  return start + Math.min(1, Math.max(0, line - (whole - 1))) * (next - start)
}
