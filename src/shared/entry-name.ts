// Regras de nome de arquivo/pasta do Windows. O main confere com elas antes de gravar e a árvore mostra o mesmo
// erro enquanto o nome é digitado; sem módulos do Node para valer nos dois processos.

// Caracteres de controle também são proibidos em nomes de arquivo no Windows.
// oxlint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const FORBIDDEN = '< > : " / \\ | ? *'

const listed = (items: string[]): string => (items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} nem ${items.at(-1)!}`)

export function entryNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'Nome vazio ou inválido.'
  const found = [...new Set(trimmed.match(INVALID_CHARS) ?? [])]
  if (found.length) {
    const printable = found.filter((c) => c >= ' ')
    const shown = printable.length < found.length ? [...printable, 'caracteres de controle'] : printable
    return `O nome não pode conter ${listed(shown)} (proibidos: ${FORBIDDEN}).`
  }
  // O Windows remove ponto/espaço no fim e recusa nomes de dispositivo, criando algo diferente do pedido.
  if (/[. ]$/.test(trimmed)) return 'O nome não pode terminar com ponto ou espaço.'
  if (RESERVED.test(trimmed)) return `"${trimmed}" é um nome reservado do Windows.`
  return null
}

// "a/b/c.ts" (ou com \) é um caminho: cada parte passa pelas regras de um nome só. "x:y" não é letra de unidade
// (só "C:\" e "C:/" são), então cai no ":" proibido do nome.
export function parseEntryPath(input: string): { parts: string[] } | { problem: string } {
  const trimmed = input.trim()
  if (/^[\\/]/.test(trimmed) || /^[a-z]:[\\/]/i.test(trimmed)) {
    return { problem: 'Use um caminho dentro da pasta, sem começar com barra ou letra de unidade.' }
  }
  const parts = trimmed.split(/[\\/]+/).filter((part) => part.trim() !== '')
  if (parts.some((part) => part.trim() === '..')) return { problem: 'O caminho não pode ter "..".' }
  if (parts.length === 0) return { problem: 'Nome vazio ou inválido.' }
  for (const part of parts) {
    const problem = entryNameProblem(part)
    if (problem) return { problem }
  }
  return { parts: parts.map((part) => part.trim()) }
}

export interface Sibling {
  name: string
  isDir: boolean
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// Conferência enquanto digita no "Novo arquivo/Nova pasta": `siblings` é o que a árvore já leu da pasta. Pastas
// mais fundas do caminho ainda não lidas ficam para o main, que confere tudo de novo ao criar.
export function newEntryProblem(input: string, siblings: readonly Sibling[]): string | null {
  const parsed = parseEntryPath(input)
  if ('problem' in parsed) return parsed.problem
  const first = parsed.parts[0]!
  const hit = siblings.find((s) => same(s.name, first))
  if (!hit) return null
  if (parsed.parts.length === 1) return `Já existe "${hit.name}" nessa pasta.`
  return hit.isDir ? null : `"${hit.name}" é um arquivo, não uma pasta.`
}

// Só mudar maiúsculas ("readme" → "README") é o mesmo item para o Windows, e vale.
export function renameProblem(input: string, current: string, siblings: readonly Sibling[]): string | null {
  const problem = entryNameProblem(input)
  if (problem) return problem
  const name = input.trim()
  if (same(name, current)) return null
  const hit = siblings.find((s) => same(s.name, name))
  return hit ? `Já existe "${hit.name}" nessa pasta.` : null
}
