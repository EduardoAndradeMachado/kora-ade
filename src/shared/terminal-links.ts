export interface PathCandidate {
  text: string
  // Índices de coluna (base 0) na linha do terminal; `end` é exclusivo.
  start: number
  end: number
}

// Caminho com extensão, absoluto do Windows (C:\...), relativo (./, ../) ou com pastas, e :linha(:coluna) opcional,
// como Claude, Codex, compiladores e linters imprimem. Nome solto sem pasta também entra (README.md): o main só
// sublinha o que existe de fato no projeto, então o excesso de candidatos não vira link falso.
const PATH_CANDIDATE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?(?:[\w.@-]+[\\/])*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/g

export function findPathCandidates(line: string): PathCandidate[] {
  const found: PathCandidate[] = []
  for (const match of line.matchAll(PATH_CANDIDATE)) {
    const start = match.index ?? 0
    const before = line[start - 1]
    // Pedaço de URL (https://site.com/a.js) é do link web, não de arquivo.
    if (before === '/' || before === ':' || /^\w+:\/\//.test(line.slice(Math.max(0, start - 12), start + 3))) continue
    found.push({ text: match[0], start, end: start + match[0].length })
  }
  return found
}

export function splitLineSuffix(text: string): { path: string; line: number | null } {
  const match = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(text)
  return { path: match?.[1] ?? text, line: match?.[2] ? Number(match[2]) : null }
}
