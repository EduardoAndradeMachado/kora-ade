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

// Linha lógica: a que o terminal quebrou por falta de largura volta a ser uma só, para URL longa não virar duas.
// cells[i] é a coluna (linha física, x) onde o caractere i do texto começa; a segunda metade de um caractere largo
// (emoji, CJK) não gera caractere, então não dá para contar índice de texto como coluna.
function logicalLine(buffer: TapBuffer, y: number, cols: number): { text: string; cells: { y: number; x: number }[] } {
  let start = y
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--
  let end = y
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++
  let text = ''
  const cells: { y: number; x: number }[] = []
  for (let row = start; row <= end; row++) {
    const line = buffer.getLine(row)
    for (let x = 0; x < cols; x++) {
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

// O que está sob o toque na célula (x, y) do buffer, ou null quando o toque caiu em texto comum.
export function targetAt(buffer: TapBuffer, cols: number, x: number, y: number): TapTarget | null {
  const { text, cells } = logicalLine(buffer, y, cols)
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
