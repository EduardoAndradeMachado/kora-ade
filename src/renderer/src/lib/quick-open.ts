// "src/app.ts:42" e "app.ts:42:7" levam à linha; o resto é o texto da busca.
export function parseQuery(text: string): { query: string; line: number | null } {
  const trimmed = text.trim()
  const match = /^(.*?\S):(\d+)(?::\d+)?$/.exec(trimmed)
  if (!match) return { query: trimmed, line: null }
  const line = Number(match[2])
  return { query: match[1]!, line: line > 0 ? line : null }
}

const SEPARATOR = /[\\/._\-\s]/
const isUpper = (ch: string | undefined): boolean => ch !== undefined && ch !== ch.toLowerCase()

// Letras da busca na ordem, não necessariamente juntas. Pesa mais o que cai em começo de palavra
// (depois de \ / . _ -, ou maiúscula de camelCase), letras seguidas e o trecho inteiro aparecendo junto.
function fuzzy(text: string, query: string): number | null {
  const lower = text.toLowerCase()
  let score = 0
  let from = 0
  let previous = -2
  for (const ch of query) {
    const at = lower.indexOf(ch, from)
    if (at < 0) return null
    score += 1
    if (at === previous + 1) score += 4
    if (at === 0 || SEPARATOR.test(text[at - 1]!) || (isUpper(text[at]) && !isUpper(text[at - 1]))) score += 6
    previous = at
    from = at + 1
  }
  const whole = lower.indexOf(query)
  if (whole === 0) score += 25
  else if (whole > 0) score += 12
  return score
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('\\') + 1)
const backslashed = (path: string): string => path.replace(/\//g, '\\')

// Busca vazia: os recentes primeiro, na ordem em que foram vistos, depois o resto do projeto.
// Com busca: o nome do arquivo pesa mais que a pasta (busca com barra nunca casa só no nome e cai no caminho
// inteiro); empate vai para o recente, depois o caminho mais curto.
export function rankFiles(files: readonly string[], rawQuery: string, recent: readonly string[], limit = 60): string[] {
  // A aba aberta pelo terminal pode ter "/" e outra caixa; no NTFS é o mesmo arquivo da listagem.
  const seen = new Set<string>()
  const candidates = [...recent, ...files].filter((path) => {
    const key = backslashed(path).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const query = rawQuery.replace(/\s+/g, '').replace(/\//g, '\\').toLowerCase()
  if (!query) return candidates.slice(0, limit)
  const recentAt = new Map(recent.map((path, i) => [path, i]))
  const scored: { path: string; score: number }[] = []
  for (const path of candidates) {
    const full = backslashed(path)
    const name = fuzzy(nameOf(full), query)
    const score = name !== null ? 1000 + name * 2 - nameOf(full).length / 100 : fuzzy(full, query)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (recentAt.get(a.path) ?? Infinity) - (recentAt.get(b.path) ?? Infinity) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path)
  )
  return scored.slice(0, limit).map((s) => s.path)
}
