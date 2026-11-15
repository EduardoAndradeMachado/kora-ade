import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createContext, Script } from 'node:vm'
import { MAX_TEXT_BYTES, resolveInside } from './files'
import { decodeText, detectEncoding, looksBinary } from './text-encoding'
import type { ProjectSearchFile, ProjectSearchMatch, ProjectSearchOptions, ProjectSearchResult } from '../shared/ipc'

// Teto para pasta gigante sem .gitignore (um backup, um dataset): a lista vai inteira pelo IPC a cada Ctrl+P.
export const MAX_PROJECT_FILES = 50_000
export const MAX_SEARCH_RESULTS = 2_000
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const READ_CONCURRENCY = 8
const PREVIEW_BEFORE = 30
const PREVIEW_LENGTH = 160
// Regex do usuário roda no processo main, o mesmo dos terminais: um padrão catastrófico como (a+)+$ travaria o app.
const REGEX_FILE_TIMEOUT_MS = 2_000

const skipped = (rel: string): boolean => rel.split(/[\\/]/).some((segment) => SKIP_DIRS.has(segment.toLowerCase()))

function gitLsFiles(root: string, args: string[]): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['--no-pager', 'ls-files', '-z', ...args],
      {
        cwd: root,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 256 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
        encoding: 'utf8'
      },
      (err, stdout) => (err ? reject(err) : resolvePromise(stdout.split('\0').filter(Boolean)))
    )
  })
}

// -z entrega o caminho cru (sem as aspas e escapes octais do core.quotepath), então acento e espaço chegam intactos.
// Os caminhos saem relativos à pasta do projeto mesmo quando o repositório começa acima dela.
async function gitFiles(root: string): Promise<string[] | null> {
  let listed: string[]
  let deleted: string[]
  let staged: string[]
  try {
    ;[listed, deleted, staged] = await Promise.all([
      gitLsFiles(root, ['--cached', '--others', '--exclude-standard']),
      gitLsFiles(root, ['--deleted']),
      gitLsFiles(root, ['--stage'])
    ])
  } catch {
    // Fora de repositório, sem git instalado ou repositório que o git recusa: a caminhada no disco serve.
    return null
  }
  const gone = new Set(deleted)
  // Submódulo aparece no --cached como se fosse arquivo ("sm", sem barra); no --stage ele tem o modo 160000.
  for (const entry of staged) if (entry.startsWith('160000 ')) gone.add(entry.slice(entry.indexOf('\t') + 1))
  const files = new Set<string>()
  for (const path of listed) {
    // Repositório aninhado não rastreado aparece como "pasta/".
    if (path.endsWith('/') || gone.has(path) || skipped(path)) continue
    files.add(sep === '/' ? path : path.split('/').join(sep))
  }
  return [...files]
}

async function walkFiles(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = []
  const dirs = ['']
  for (let i = 0; i < dirs.length && files.length < maxFiles; i++) {
    const rel = dirs[i]
    let entries: Dirent[]
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch (err) {
      if (rel === '') throw err
      continue
    }
    for (const entry of entries) {
      // Junção e link podem apontar para fora do projeto ou de volta para cima (laço infinito).
      if (entry.isSymbolicLink()) continue
      const path = rel ? join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) dirs.push(path)
      } else if (entry.isFile()) files.push(path)
    }
  }
  return files
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// O filtro vem antes do teto: "Buscar na pasta" num projeto enorme lê a pasta inteira, não o que sobrou dos primeiros.
async function inventory(
  root: string,
  include: ((rel: string) => boolean) | null,
  maxFiles: number
): Promise<{ files: string[]; capped: boolean }> {
  const tracked = await gitFiles(root)
  const listed = tracked ?? (await walkFiles(root, maxFiles))
  // A caminhada para no teto antes de ver o resto do disco; a lista do git vem sempre inteira.
  const walkStopped = tracked === null && listed.length >= maxFiles
  const all = include ? listed.filter(include) : listed
  return { files: all.sort(byPath).slice(0, maxFiles), capped: walkStopped || all.length > maxFiles }
}

export async function listProjectFiles(root: string, maxFiles = MAX_PROJECT_FILES): Promise<string[]> {
  return (await inventory(root, null, maxFiles)).files
}

// Mesma leitura que o editor faz (readText): assim "ação" é achado no arquivo Windows-1252 que o editor mostra como
// "ação". O BOM sai do texto porque o Monaco também o tira do modelo, e a coluna do resultado precisa bater.
export function decodeForSearch(bytes: Buffer): string | null {
  const encoding = detectEncoding(bytes)
  if (looksBinary(bytes, encoding)) return null
  return decodeText(bytes, encoding).replace(/^﻿/, '')
}

// Só os caracteres de sintaxe: com a flag u, escapar qualquer outro (como "-" em "btn-primary") é erro de sintaxe.
const escapeRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

function globSource(path: string): string {
  const segments = path.split('/').filter((segment, i, all) => !(segment === '**' && all[i - 1] === '**'))
  return segments
    .map((segment, i) => {
      const last = i === segments.length - 1
      if (segment === '**') return last ? '.*' : '(?:[^/]+/)*'
      const body = segment
        .split(/([*?])/)
        .map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeRegex(part)))
        .join('')
      return last ? body : `${body}/`
    })
    .join('')
}

// Mesma leitura do "arquivos a incluir/excluir" do VS Code: cada item casa o próprio caminho ou qualquer coisa
// dentro dele, por segmento inteiro ("src" não pega "srcx") e sem diferenciar maiúsculas, como o sistema de
// arquivos do Windows. 'root': um item é ".\", a raiz, que casa o projeto todo.
function filterPatterns(list: string | undefined): RegExp[] | 'root' {
  const patterns: RegExp[] = []
  for (const raw of (list ?? '').split(',')) {
    const item = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (item === '') continue
    const anchored = /^\.?\//.test(item) || item === '.'
    const path = item.replace(/^\.?\/+/, '').replace(/^\.$/, '')
    if (path === '') return 'root'
    const prefix = anchored || path.startsWith('**') ? '' : '(?:[^/]+/)*'
    patterns.push(new RegExp(`^${prefix}${globSource(path)}(?:/.*)?$`, 'ius'))
  }
  return patterns
}

const matchesAny = (patterns: RegExp[], rel: string): boolean => {
  const path = rel.replace(/\\/g, '/')
  return patterns.some((pattern) => pattern.test(path))
}

// null: sem filtro. Com ".\" o projeto todo entra, e os outros itens não restringem mais nada.
export function includeMatcher(include: string | undefined): ((rel: string) => boolean) | null {
  const patterns = filterPatterns(include)
  if (patterns === 'root' || patterns.length === 0) return null
  return (rel) => matchesAny(patterns, rel)
}

// Inclui e exclui juntos, como no VS Code: o arquivo precisa casar o incluir (se houver) e não casar o excluir.
// Excluir ".\" tiraria o projeto inteiro; como no incluir, a raiz não filtra nada.
export function searchFilter(include: string | undefined, exclude: string | undefined): ((rel: string) => boolean) | null {
  const keep = includeMatcher(include)
  const drop = filterPatterns(exclude)
  if (drop === 'root' || drop.length === 0) return keep
  return (rel) => (keep === null || keep(rel)) && !matchesAny(drop, rel)
}

// \b do JavaScript só conhece letras ASCII: "ação" teria fronteira de palavra no meio.
const WORD_CHAR = '[\\p{L}\\p{N}\\p{M}_]'

export function searchPattern(query: string, opts: ProjectSearchOptions): RegExp {
  const source = opts.regex ? query : escapeRegex(query)
  const wrapped = opts.wholeWord ? `(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})` : source
  try {
    return new RegExp(wrapped, opts.caseSensitive ? 'gu' : 'giu')
  } catch (err) {
    throw new Error(`Expressão regular inválida: ${err instanceof Error ? err.message.replace(/^Invalid regular expression: /, '') : String(err)}`)
  }
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

// Linha minificada pode ter megabytes: o trecho guarda um pouco antes da ocorrência e corta o resto.
function preview(line: string, start: number, end: number): Pick<ProjectSearchMatch, 'preview' | 'start' | 'end'> {
  const indent = line.length - line.trimStart().length
  let from = Math.max(Math.min(indent, start), start - PREVIEW_BEFORE)
  if (from > 0 && isLowSurrogate(line.charCodeAt(from))) from--
  const contentEnd = line.trimEnd().length
  let to = Math.min(Math.max(contentEnd, end), from + PREVIEW_LENGTH)
  if (to < line.length && isLowSurrogate(line.charCodeAt(to))) to++
  const head = from > indent ? '…' : ''
  const tail = to < contentEnd ? '…' : ''
  return {
    preview: head + line.slice(from, to) + tail,
    start: head.length + start - from,
    end: head.length + Math.min(end, to) - from
  }
}

export function findMatches(pattern: RegExp, text: string, limit: number): ProjectSearchMatch[] {
  const matches: ProjectSearchMatch[] = []
  // Monaco também quebra linha em \r sozinho; a contagem tem de bater com a linha para onde o clique leva.
  const lines = text.split(/\r\n|\r|\n/)
  for (const [i, line] of lines.entries()) {
    pattern.lastIndex = 0
    let found: RegExpExecArray | null
    while ((found = pattern.exec(line)) !== null) {
      if (found[0].length === 0) {
        // Com a flag u, parar no meio de um par surrogate (emoji) faz o motor voltar ao início do par e casar
        // vazio de novo para sempre: o avanço é de um caractere inteiro.
        pattern.lastIndex += (line.codePointAt(pattern.lastIndex) ?? 0) > 0xffff ? 2 : 1
        continue
      }
      matches.push({
        line: i + 1,
        column: found.index + 1,
        length: found[0].length,
        ...preview(line, found.index, found.index + found[0].length)
      })
      if (matches.length >= limit) return matches
    }
  }
  return matches
}

class RegexTimeoutError extends Error {}

function guardedMatcher(pattern: RegExp, regexMode: boolean): (text: string, limit: number, rel: string) => ProjectSearchMatch[] {
  if (!regexMode) return (text, limit) => findMatches(pattern, text, limit)
  // O timeout do vm interrompe qualquer JavaScript em execução, inclusive o backtracking do motor de regex.
  const context = createContext({ scan: null as (() => ProjectSearchMatch[]) | null, result: null })
  const run = new Script('result = scan()')
  return (text, limit, rel) => {
    context.scan = () => findMatches(pattern, text, limit)
    try {
      run.runInContext(context, { timeout: REGEX_FILE_TIMEOUT_MS })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new RegexTimeoutError(`A expressão regular demorou demais em ${rel}. Simplifique a busca.`)
      }
      throw err
    }
    return context.result as ProjectSearchMatch[]
  }
}

async function readSearchable(root: string, rel: string): Promise<string | null> {
  try {
    // resolveInside confere o caminho real: uma pasta rastreada trocada por junção para fora do projeto continua
    // listada pelo git com os mesmos nomes, e o lstat do arquivo sozinho não vê a junção acima dele.
    const abs = resolveInside(root, rel)
    const stat = await lstat(abs)
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null
    return decodeForSearch(await readFile(abs))
  } catch {
    // Apagado entre a listagem e a leitura, ou travado por outro programa.
    return null
  }
}

export function normalizeSearchOptions(raw: unknown): ProjectSearchOptions {
  const opts = (raw ?? {}) as Partial<Record<keyof ProjectSearchOptions, unknown>>
  return {
    caseSensitive: opts.caseSensitive === true,
    wholeWord: opts.wholeWord === true,
    regex: opts.regex === true,
    ...(typeof opts.include === 'string' && opts.include.trim() !== '' ? { include: opts.include } : {}),
    ...(typeof opts.exclude === 'string' && opts.exclude.trim() !== '' ? { exclude: opts.exclude } : {})
  }
}

// null quando outra busca começou antes desta terminar.
export async function searchProject(
  root: string,
  query: string,
  opts: ProjectSearchOptions,
  signal?: AbortSignal,
  maxFiles = MAX_PROJECT_FILES
): Promise<ProjectSearchResult | null> {
  if (query === '') return { files: [], total: 0, truncated: false, capped: false }
  const pattern = searchPattern(query, opts)
  const match = guardedMatcher(pattern, opts.regex)
  const { files, capped } = await inventory(root, searchFilter(opts.include, opts.exclude), maxFiles)
  if (signal?.aborted) return null

  const perFile: (ProjectSearchFile | undefined)[] = []
  let next = 0
  let found = 0
  let failure: unknown = null
  // Uma ocorrência além do teto: é ela que prova que faltou resultado.
  const limit = MAX_SEARCH_RESULTS + 1
  const worker = async (): Promise<void> => {
    while (next < files.length && found < limit && !signal?.aborted && failure === null) {
      const index = next++
      const path = files[index] ?? ''
      const text = await readSearchable(root, path)
      if (text === null || signal?.aborted || failure !== null) continue
      try {
        // Teto por arquivo fixo, não o que sobra: arquivos terminam fora de ordem e o corte final é na ordem da lista.
        const matches = match(text, limit, path)
        perFile[index] = { path, matches }
        found += matches.length
      } catch (err) {
        failure = err
      }
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
  if (signal?.aborted) return null
  if (failure !== null) throw failure

  // Os leitores terminam fora de ordem; os arquivos de índice menor que `next` foram todos lidos, então cortar
  // na ordem da lista dá o mesmo resultado que uma leitura em sequência.
  const result: ProjectSearchFile[] = []
  let total = 0
  for (const file of perFile) {
    if (total >= MAX_SEARCH_RESULTS) break
    if (!file || file.matches.length === 0) continue
    const kept = file.matches.slice(0, MAX_SEARCH_RESULTS - total)
    result.push({ path: file.path, matches: kept })
    total += kept.length
  }
  return { files: result, total, truncated: found > MAX_SEARCH_RESULTS, capped }
}

// Uma busca por vez para a janela: digitar de novo cancela a anterior em vez de deixá-la lendo o disco.
export function latestSearch(): (root: string, query: string, opts: ProjectSearchOptions) => Promise<ProjectSearchResult | null> {
  let current: AbortController | null = null
  return (root, query, opts) => {
    current?.abort()
    const controller = new AbortController()
    current = controller
    return searchProject(root, query, opts, controller.signal).finally(() => {
      if (current === controller) current = null
    })
  }
}
