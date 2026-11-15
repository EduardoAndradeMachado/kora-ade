// Blocos de conflito que o git escreve no arquivo:
//   <<<<<<< HEAD          (atual: o que já estava na branch)
//   ...
//   ||||||| base          (só com merge.conflictStyle=diff3/zdiff3)
//   ...
//   =======
//   ...                   (entrada: o que está chegando)
//   >>>>>>> outra-branch
// Marcador só conta no começo da linha, como no VS Code; o mesmo texto no meio de uma linha não é conflito.
// Linhas numeradas a partir de 1 (como no Monaco); faixa vazia tem end < start.

export interface LineRange {
  start: number
  end: number
}

export interface ConflictBlock {
  startLine: number
  separatorLine: number
  endLine: number
  baseLine: number | null
  current: LineRange
  base: LineRange | null
  incoming: LineRange
  currentLabel: string
  incomingLabel: string
}

export type ConflictChoice = 'current' | 'incoming' | 'both'

const marker = (line: string, char: string): string | null => {
  const head = char.repeat(7)
  if (!line.startsWith(head)) return null
  const rest = line.slice(7)
  // "<<<<<<<<" (oito) não é marcador; o rótulo vem depois de um espaço.
  if (rest === '') return ''
  return rest[0] === ' ' ? rest.slice(1) : null
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

export function parseConflicts(lines: readonly string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = []
  let open: { startLine: number; label: string; baseLine: number | null; separatorLine: number | null } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const n = i + 1
    const start = marker(line, '<')
    // Início novo antes do fim descarta o bloco incompleto, como o VS Code.
    if (start !== null) {
      open = { startLine: n, label: start, baseLine: null, separatorLine: null }
      continue
    }
    if (!open) continue
    if (open.separatorLine === null) {
      if (open.baseLine === null && marker(line, '|') !== null) open.baseLine = n
      else if (line === '=======' || line.startsWith('======= ')) open.separatorLine = n
      continue
    }
    const end = marker(line, '>')
    if (end === null) continue
    const { startLine, baseLine, separatorLine } = open
    blocks.push({
      startLine,
      separatorLine,
      endLine: n,
      baseLine,
      current: { start: startLine + 1, end: (baseLine ?? separatorLine) - 1 },
      base: baseLine === null ? null : { start: baseLine + 1, end: separatorLine - 1 },
      incoming: { start: separatorLine + 1, end: n - 1 },
      currentLabel: open.label,
      incomingLabel: end
    })
    open = null
  }
  return blocks
}

const take = (lines: readonly string[], range: LineRange): string[] => lines.slice(range.start - 1, range.end)

export function chosenLines(lines: readonly string[], block: ConflictBlock, choice: ConflictChoice): string[] {
  if (choice === 'current') return take(lines, block.current)
  if (choice === 'incoming') return take(lines, block.incoming)
  return [...take(lines, block.current), ...take(lines, block.incoming)]
}

// Edição no formato do Monaco (linha e coluna a partir de 1) que troca o bloco inteiro, marcadores inclusive,
// pelas linhas escolhidas.
export interface ConflictEdit {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  text: string
}

export function resolutionEdit(lines: readonly string[], block: ConflictBlock, choice: ConflictChoice, eol: string): ConflictEdit {
  const chosen = chosenLines(lines, block, choice)
  const lastColumn = (line: number): number => lines[line - 1]!.length + 1
  if (block.endLine < lines.length) {
    return { startLine: block.startLine, startColumn: 1, endLine: block.endLine + 1, endColumn: 1, text: chosen.map((l) => l + eol).join('') }
  }
  // O ">>>>>>>" é a última linha (arquivo sem quebra no fim): a quebra a remover é a de antes do bloco.
  if (block.startLine > 1) {
    const before = block.startLine - 1
    return { startLine: before, startColumn: lastColumn(before), endLine: block.endLine, endColumn: lastColumn(block.endLine), text: chosen.map((l) => eol + l).join('') }
  }
  return { startLine: 1, startColumn: 1, endLine: block.endLine, endColumn: lastColumn(block.endLine), text: chosen.join(eol) }
}

export const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')

function offsetOf(lines: readonly string[], eol: string, line: number, column: number): number {
  let offset = 0
  for (let i = 0; i < line - 1; i++) offset += lines[i]!.length + eol.length
  return offset + column - 1
}

export function applyEdit(text: string, edit: ConflictEdit): string {
  const eol = eolOf(text)
  const lines = splitLines(text)
  const from = offsetOf(lines, eol, edit.startLine, edit.startColumn)
  const to = offsetOf(lines, eol, edit.endLine, edit.endColumn)
  return text.slice(0, from) + edit.text + text.slice(to)
}

export function resolveConflict(text: string, block: ConflictBlock, choice: ConflictChoice): string {
  return applyEdit(text, resolutionEdit(splitLines(text), block, choice, eolOf(text)))
}

// O arquivo inteiro com todos os blocos resolvidos para um lado: os dois lados do "Comparar alterações".
export function resolveAll(text: string, choice: ConflictChoice): string {
  const blocks = parseConflicts(splitLines(text))
  let result = text
  // Do último para o primeiro: resolver um bloco não desloca as linhas dos anteriores.
  for (const block of [...blocks].reverse()) result = resolveConflict(result, block, choice)
  return result
}

export const hasConflictBlocks = (text: string): boolean => parseConflicts(splitLines(text)).length > 0
