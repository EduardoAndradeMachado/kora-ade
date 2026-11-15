import { findPathCandidates } from '../../../shared/terminal-links'

// O mínimo do buffer do xterm que o toque usa; o @xterm/xterm e o @xterm/headless têm o mesmo formato.
interface Cell { getChars(): string; getWidth(): number }
interface Line { isWrapped: boolean; getCell(x: number): Cell | undefined }
export interface TapBuffer { length: number; getLine(y: number): Line | undefined }

export type TapTarget = { kind: 'url'; text: string } | { kind: 'path'; text: string }

// Dedo cobre mais de uma célula, ainda mais com o terminal reduzido para caber na largura: aceita o link a até
// duas células do toque.
const REACH = 2
const URL = /https?:\/\/[^\s<>"'`]+/g
const URL_TAIL = /[.,;:!?)\]}'"]+$/

// Caracteres que só aparecem no meio de URL ou caminho: num pedaço que começa a linha, indicam a continuação de um
// link cortado na linha de cima, e não o começo de uma frase.
const LINK_INSIDE = /[/\\?=&%#~+]/
// Último caractere que não fecha URL: a que termina nele, encostada na margem, foi cortada.
const LINK_END = /[/=?&#%_-]$/
// Só caracteres de URL ou caminho: moldura de tela (─, │) colada embaixo não vira pedaço do link.
const LINK_CHARS = /^[\w\-.~:/?#[\]@!$&'()*+,;=%\\]+$/

function rowText(buffer: TapBuffer, y: number, cols: number): string {
  const line = buffer.getLine(y)
  let text = ''
  for (let x = 0; x < cols; x++) {
    const cell = line?.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    text += cell.getChars() || ' '
  }
  return text
}

// Recuo da linha y + 1 quando ela continua o link que a linha y deixou cortado na última coluna, ou null. O Claude
// e o Codex quebram a linha eles mesmos (sem a marca de quebra automática do terminal) e cortam a URL que não cabe
// na largura; a continuação vem na linha de baixo, às vezes recuada para alinhar com o texto.
function cutContinuation(buffer: TapBuffer, y: number, cols: number): number | null {
  if (y + 1 >= buffer.length) return null
  const above = rowText(buffer, y, cols)
  const tail = /\S+$/.exec(above)
  if (!tail || tail.index + tail[0].length < cols || !LINK_CHARS.test(tail[0].slice(-1))) return null
  const below = rowText(buffer, y + 1, cols)
  const indent = below.length - below.trimStart().length
  const head = /^\S+/.exec(below.slice(indent))?.[0]
  if (!head || indent > tail.index || !LINK_CHARS.test(head)) return null
  // Pasta no fim (src/) ou URL que para num caractere que não fecha URL: o resto está embaixo.
  const cutMidway = /[/\\]$/.test(tail[0]) || (/https?:\/\//.test(tail[0]) && LINK_END.test(tail[0]))
  return cutMidway || LINK_INSIDE.test(head) || indent + head.length >= cols ? indent : null
}

// Linha lógica: a que o terminal quebrou por falta de largura volta a ser uma só, para URL longa não virar duas; com
// `cut`, também a que o programa cortou (cutContinuation), sem o recuo da continuação.
// cells[i] é a coluna (linha física, x) onde o caractere i do texto começa; a segunda metade de um caractere largo
// (emoji, CJK) não gera caractere, então não dá para contar índice de texto como coluna.
function logicalLine(buffer: TapBuffer, y: number, cols: number, cut: boolean): { text: string; cells: { y: number; x: number }[] } {
  // O ConPTY não manda a quebra de linha depois de uma linha que enche a largura: a de baixo chega como quebra
  // automática (isWrapped) mesmo quando o programa quebrou e recuou. Por isso o corte é conferido antes da marca.
  const joins = (row: number): number | null => {
    if (row + 1 >= buffer.length) return null
    const indent = cut ? cutContinuation(buffer, row, cols) : null
    if (indent !== null) return indent
    return buffer.getLine(row + 1)?.isWrapped ? 0 : null
  }
  let start = y
  while (start > 0 && joins(start - 1) !== null) start--
  const rows: { row: number; from: number }[] = [{ row: start, from: 0 }]
  for (let from = joins(start); from !== null; from = joins(rows.at(-1)!.row)) rows.push({ row: rows.at(-1)!.row + 1, from })
  let text = ''
  const cells: { y: number; x: number }[] = []
  for (const { row, from } of rows) {
    const line = buffer.getLine(row)
    for (let x = from; x < cols; x++) {
      const cell = line?.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (let i = 0; i < chars.length; i++) cells.push({ y: row, x })
      text += chars
    }
  }
  return { text, cells }
}

function candidates(text: string): (TapTarget & { start: number; end: number })[] {
  const urls = [...text.matchAll(URL)].map((match) => {
    const raw = match[0].replace(URL_TAIL, '')
    return { kind: 'url' as const, text: raw, start: match.index ?? 0, end: (match.index ?? 0) + raw.length }
  })
  // findPathCandidates já deixa de fora o arquivo que faz parte de uma URL.
  const paths = findPathCandidates(text).map((path) => ({ kind: 'path' as const, ...path }))
  return [...urls, ...paths]
}

// O que está sob o toque na célula (x, y) do buffer, ou null quando o toque caiu em texto comum. Caminho que só
// existe juntando a linha cortada vem com `alone`, o caminho lido sem juntar: o corte pode ter sido só uma palavra
// que encostou na margem, e quem abre tenta os dois.
export function targetAt(buffer: TapBuffer, cols: number, x: number, y: number): (TapTarget & { alone?: string }) | null {
  const joined = targetIn(buffer, cols, x, y, true)
  if (joined?.kind !== 'path') return joined
  const alone = targetIn(buffer, cols, x, y, false)
  return alone?.kind === 'path' && alone.text !== joined.text ? { ...joined, alone: alone.text } : joined
}

function targetIn(buffer: TapBuffer, cols: number, x: number, y: number, cut: boolean): TapTarget | null {
  const { text, cells } = logicalLine(buffer, y, cols, cut)
  const distance = (index: number): number => {
    const cell = cells[index]
    return !cell ? Infinity : cell.y !== y ? Infinity : Math.abs(cell.x - x)
  }
  let best: { target: TapTarget; gap: number } | null = null
  for (const found of candidates(text)) {
    let gap = Infinity
    for (let i = found.start; i < found.end; i++) gap = Math.min(gap, distance(i))
    if (gap <= REACH && (!best || gap < best.gap)) best = { target: { kind: found.kind, text: found.text }, gap }
  }
  return best?.target ?? null
}
