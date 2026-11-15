// Parte da navegação entre arquivos (F12, Shift+F12) que não depende do Monaco: quais arquivos do projeto vão para o
// worker do TypeScript, com que nome e com que opções de compilação.

// Teto pensando em repositório grande: o worker guarda o texto e a árvore de cada arquivo, e com arquivos JS e TS no
// mesmo projeto são dois workers com a mesma lista. Acima disso a navegação cobre só os mais próximos do arquivo aberto.
export const MAX_NAV_FILES = 2_500
export const MAX_NAV_BYTES = 12 * 1024 * 1024
// Arquivo maior que isso costuma ser gerado (bundle, dado embutido): pesa no worker e ninguém navega até ele.
export const MAX_NAV_FILE_BYTES = 1024 * 1024

const NAV_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
// Fora do git a lista do projeto traz tudo; saída de build repetiria cada símbolo e esconderia o fonte.
const SKIP_SEGMENTS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.next', '.nuxt', '.turbo', '.vite', '.cache', '.git'])
const TSCONFIG = /^[jt]sconfig(?:\..+)?\.json$/i

const segments = (rel: string): string[] => rel.split(/[\\/]/)

const skipped = (rel: string): boolean => segments(rel).some((s) => SKIP_SEGMENTS.has(s.toLowerCase()))

export const isNavFile = (rel: string): boolean => NAV_FILE.test(rel) && !/\.min\.[cm]?js$/i.test(rel) && !skipped(rel)

export const isTsconfig = (rel: string): boolean => TSCONFIG.test(segments(rel).pop() ?? '') && !skipped(rel)

// Os mais próximos do arquivo aberto primeiro (mais pastas em comum), depois os mais rasos: com o teto estourado, o
// que fica de fora é o que está longe de onde o usuário trabalha.
export function navCandidates(files: string[], near: string): string[] {
  const nearDir = segments(near.toLowerCase()).slice(0, -1)
  const shared = (rel: string): number => {
    const parts = segments(rel.toLowerCase()).slice(0, -1)
    let n = 0
    while (n < parts.length && n < nearDir.length && parts[n] === nearDir[n]) n++
    return n
  }
  return files
    .filter(isNavFile)
    .map((rel) => ({ rel, shared: shared(rel), depth: segments(rel).length }))
    .sort((a, b) => b.shared - a.shared || a.depth - b.depth || a.rel.localeCompare(b.rel))
    .slice(0, MAX_NAV_FILES)
    .map((c) => c.rel)
}

// Caminho da URI de um arquivo do projeto no Monaco: o mesmo para o model do editor e para o nome no worker, senão o
// worker veria o arquivo aberto e a cópia do disco como dois arquivos.
export const projectUriPath = (projectId: string, rel: string): string => `/${projectId}/${rel.replace(/\\/g, '/')}`

export function relFromUriPath(projectId: string, uriPath: string): string | null {
  const prefix = `/${projectId}/`
  if (!uriPath.startsWith(prefix) || uriPath.length === prefix.length) return null
  return uriPath.slice(prefix.length).replace(/\//g, '\\')
}

// tsconfig aceita comentário e vírgula sobrando; o JSON.parse não.
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      out += text.slice(start, ++i)
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return null
  }
}

// Resolve "./a/../b" a partir de uma pasta do projeto; null se sair da raiz.
function joinRel(dir: string[], path: string): string[] | null {
  const out = [...dir]
  for (const part of path.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(part)
  }
  return out
}

// "paths" do tsconfig com os destinos já como URI do projeto. Destino absoluto dispensa o baseUrl (que o TypeScript 6
// marca como obsoleto) e deixa juntar tsconfigs de pastas diferentes numa configuração só. "extends" não é seguido.
export function pathsFromTsconfig(rel: string, text: string, toUri: (rel: string) => string): Record<string, string[]> {
  const config = parseJsonc(text) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | null
  const options = config?.compilerOptions
  const paths = options?.paths
  if (!paths || typeof paths !== 'object') return {}
  const configDir = segments(rel).slice(0, -1)
  const base = typeof options.baseUrl === 'string' ? joinRel(configDir, options.baseUrl) : configDir
  if (!base) return {}
  const result: Record<string, string[]> = {}
  for (const [alias, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue
    const resolved: string[] = []
    for (const target of targets) {
      if (typeof target !== 'string') continue
      const star = target.indexOf('*')
      const head = star === -1 ? target : target.slice(0, star)
      const dirOnly = head === '' || /[\\/]$/.test(head)
      const parts = joinRel(base, head)
      if (!parts) continue
      const prefix = parts.join('/') + (dirOnly && parts.length > 0 ? '/' : '')
      resolved.push(toUri(prefix) + (star === -1 ? '' : target.slice(star)))
    }
    if (resolved.length > 0) result[alias] = resolved
  }
  return result
}

// Dois tsconfigs com o mesmo apelido (monorepo): o TypeScript tenta os destinos na ordem e fica com o que existe.
export function mergePaths(list: Record<string, string[]>[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  for (const paths of list) {
    for (const [alias, targets] of Object.entries(paths)) {
      merged[alias] = [...new Set([...(merged[alias] ?? []), ...targets])]
    }
  }
  return merged
}

// Valores numéricos dos enums do TypeScript (ScriptTarget.ESNext, ModuleKind.ESNext, ModuleResolutionKind.Bundler,
// JsxEmit.ReactJSX): o Monaco só exporta parte desses enums e o Bundler não está entre eles. Bundler resolve como o
// Vite: "./a.js" acha a.ts, pasta acha index, sem exigir extensão.
export function navCompilerOptions(paths: Record<string, string[]>): Record<string, unknown> {
  return {
    target: 99,
    module: 99,
    moduleResolution: 100,
    jsx: 4,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    esModuleInterop: true,
    noEmit: true,
    paths
  }
}
