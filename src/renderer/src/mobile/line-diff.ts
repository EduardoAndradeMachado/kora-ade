// Comparação por linhas entre a versão do PC e o rascunho do celular, para o "Comparar" do aviso de conflito.
// before/after: o número da linha (base 1) em cada lado; a linha só de um lado não tem o do outro.
export type DiffLine =
  | { kind: 'same'; text: string; before: number; after: number }
  | { kind: 'removed'; text: string; before: number }
  | { kind: 'added'; text: string; after: number }

// Acima disto o miolo diferente (depois de tirar o começo e o fim iguais) vira "tudo saiu, tudo entrou": a tabela da
// maior subsequência comum custa linhas x linhas, e 4 milhões de células (16 MB) já é o que dá no celular.
export const MAX_DIFF_CELLS = 4_000_000

const splitLines = (text: string): string[] => text.split(/\r\n|\n|\r/)

export function lineDiff(beforeText: string, afterText: string, maxCells = MAX_DIFF_CELLS): DiffLine[] {
  const a = splitLines(beforeText)
  const b = splitLines(afterText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i]!, before: i + 1, after: i + 1 })
  const n = endA - start
  const m = endB - start
  if (n * m <= maxCells) out.push(...middle(a, b, start, n, m))
  else {
    for (let i = 0; i < n; i++) out.push({ kind: 'removed', text: a[start + i]!, before: start + i + 1 })
    for (let j = 0; j < m; j++) out.push({ kind: 'added', text: b[start + j]!, after: start + j + 1 })
  }
  for (let k = 0; k < a.length - endA; k++) out.push({ kind: 'same', text: a[endA + k]!, before: endA + k + 1, after: endB + k + 1 })
  return out
}

// Maior subsequência comum de baixo para cima: lcs[i][j] é o tamanho dela entre a[i..] e b[j..], e o caminho sai em
// ordem de leitura. No empate, a linha removida vem antes da adicionada, como no git.
function middle(a: string[], b: string[], offset: number, n: number, m: number): DiffLine[] {
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[offset + i] === b[offset + j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[offset + i] === b[offset + j]) {
      out.push({ kind: 'same', text: a[offset + i]!, before: offset + i + 1, after: offset + j + 1 })
      i++
      j++
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      out.push({ kind: 'removed', text: a[offset + i]!, before: offset + i + 1 })
      i++
    } else {
      out.push({ kind: 'added', text: b[offset + j]!, after: offset + j + 1 })
      j++
    }
  }
  return out
}

export type DiffRow = DiffLine | { kind: 'skip'; count: number }

// Na tela pequena só a vizinhança do que mudou: trechos iguais maiores que 2 x context viram "N linhas iguais".
export function foldUnchanged(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const out: DiffRow[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind !== 'same') {
      out.push(lines[i]!)
      i++
      continue
    }
    let end = i
    while (end < lines.length && lines[end]!.kind === 'same') end++
    const keepBefore = i === 0 ? 0 : context
    const keepAfter = end === lines.length ? 0 : context
    if (end - i > keepBefore + keepAfter) {
      out.push(...lines.slice(i, i + keepBefore))
      out.push({ kind: 'skip', count: end - i - keepBefore - keepAfter })
      out.push(...lines.slice(end - keepAfter, end))
    } else out.push(...lines.slice(i, end))
    i = end
  }
  return out
}
