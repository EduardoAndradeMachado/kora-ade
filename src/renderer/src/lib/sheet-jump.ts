import { parseCsv, type Delimiter } from './csv'

// Onde cai a linha N do arquivo (o `dados.csv:42` do terminal) na grade da planilha.
// row: índice na lista de dados (sem o cabeçalho), o mesmo que a grade guarda por trás de filtro e ordem.
export type SheetJump = { kind: 'row'; row: number } | { kind: 'header' }

const LF = 0x0a
const CR = 0x0d

// Registro que contém a linha `line` (base 1) do texto. Quebra de linha dentro de aspas faz um registro ocupar várias
// linhas do arquivo, então a linha do arquivo não é o número do registro. Linha além do fim cai no último registro.
export function csvRecordAtLine(text: string, delimiter: Delimiter, line: number): number {
  const starts: number[] = []
  parseCsv(text, delimiter, Infinity, starts)
  if (starts.length === 0) return -1
  let current = 1
  let at = 0
  let found = 0
  for (let r = 0; r < starts.length; r++) {
    const start = starts[r]!
    for (; at < start; at++) {
      const c = text.charCodeAt(at)
      if (c === LF || (c === CR && text.charCodeAt(at + 1) !== LF)) current++
    }
    if (current > line) break
    found = r
  }
  return found
}

// record: índice entre todas as linhas lidas (o cabeçalho é o 0 quando existe).
export function sheetJumpFor(record: number, hasHeader: boolean): SheetJump | null {
  if (record < 0) return null
  if (hasHeader && record === 0) return { kind: 'header' }
  return { kind: 'row', row: hasHeader ? record - 1 : record }
}
