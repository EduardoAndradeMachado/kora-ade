import { cpSync, openSync, readdirSync, readFileSync, readSync, closeSync, lstatSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileEntry, TextFile } from '../shared/ipc'

const HIDDEN = new Set(['.git'])
const MAX_TEXT_BYTES = 5 * 1024 * 1024

// O renderer só manda caminhos relativos ao projeto; qualquer coisa que resolva para fora da raiz é recusada.
export function resolveInside(root: string, rel: string): string {
  const target = resolve(root, rel)
  const fromRoot = relative(resolve(root), target)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Caminho fora do projeto: ${rel}`)
  }
  return target
}

export function listDir(root: string, rel: string): FileEntry[] {
  const dir = resolveInside(root, rel)
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => ({
      name: d.name,
      path: rel ? join(rel, d.name) : d.name,
      isDir: d.isDirectory()
    }))
    .sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) : a.isDir ? -1 : 1
    )
}

function looksBinary(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const sample = Buffer.alloc(8192)
    const read = readSync(fd, sample, 0, sample.length, 0)
    return sample.subarray(0, read).includes(0)
  } finally {
    closeSync(fd)
  }
}

export function readText(root: string, rel: string): TextFile {
  const file = resolveInside(root, rel)
  const stat = statSync(file)
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`Arquivo grande demais para abrir aqui: ${rel}`)
  if (looksBinary(file)) throw new Error(`Arquivo binário, abra no programa padrão: ${rel}`)
  return { content: readFileSync(file, 'utf8'), mtimeMs: stat.mtimeMs }
}

export class ConflictError extends Error {}

// O Claude/Codex editam os mesmos arquivos em paralelo: salvar por cima de uma versão
// que mudou no disco depois de aberta apagaria o trabalho deles sem aviso.
export function writeText(root: string, rel: string, content: string, expectedMtimeMs: number): number {
  const file = resolveInside(root, rel)
  const current = statSync(file).mtimeMs
  if (current !== expectedMtimeMs) {
    throw new ConflictError(`O arquivo mudou no disco depois de aberto: ${rel}`)
  }
  writeFileSync(file, content, 'utf8')
  return statSync(file).mtimeMs
}

export class MoveConflictError extends Error {}

function lstatOrNull(abs: string): Stats | null {
  try {
    return lstatSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function missing(message: string): Error {
  return Object.assign(new Error(`ENOENT: ${message}`), { code: 'ENOENT' })
}

// path.relative já compara sem diferenciar maiúsculas no Windows; comparar segmentos
// inteiros evita que "docs-velhos" pareça estar dentro de "docs".
function isSameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

export function touchesGit(projectRoot: string, abs: string): boolean {
  return relative(projectRoot, abs)
    .split(sep)
    .some((segment) => HIDDEN.has(segment.toLowerCase()))
}

export function moveEntry(root: string, fromRel: string, toDirRel: string): string {
  const projectRoot = resolve(root)
  const from = resolveInside(root, fromRel)
  const toDir = resolveInside(root, toDirRel)

  if (relative(projectRoot, from) === '') throw new Error('Não é possível mover a raiz do projeto.')
  if (touchesGit(projectRoot, from) || touchesGit(projectRoot, toDir)) {
    throw new Error('Não é possível mover itens de dentro ou para dentro do .git.')
  }

  const source = lstatOrNull(from)
  if (!source) throw missing(`o item não existe mais: ${fromRel}`)
  const destination = lstatOrNull(toDir)
  if (!destination) throw missing(`a pasta de destino não existe mais: ${toDirRel || '(raiz do projeto)'}`)
  if (!destination.isDirectory()) throw new Error(`O destino não é uma pasta: ${toDirRel}`)

  if (relative(dirname(from), toDir) === '') return relative(projectRoot, from)

  if (source.isDirectory() && isSameOrInside(from, toDir)) {
    throw new Error(`Não é possível mover a pasta "${basename(from)}" para dentro dela mesma.`)
  }

  const target = join(toDir, basename(from))
  // renameSync substitui arquivo existente sem avisar (no Windows usa MOVEFILE_REPLACE_EXISTING).
  if (lstatOrNull(target)) {
    throw new MoveConflictError(`Já existe "${basename(from)}" na pasta de destino.`)
  }
  renameSync(from, target)
  return relative(projectRoot, target)
}

// "nome.ext" livre na pasta, ou "nome (2).ext", "nome (3).ext"... como o Windows faz ao colar em cima de um igual.
function freeName(dir: string, name: string, isDir: boolean): string {
  if (!lstatOrNull(join(dir, name))) return name
  const dot = isDir ? -1 : name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!lstatOrNull(join(dir, candidate))) return candidate
  }
}

// Arquivos e pastas soltos de fora do app (Explorer do Windows) entram no projeto como cópia: o original fica
// onde estava, como no VS Code. Nada é sobrescrito; item que já está nessa mesma pasta é ignorado.
export function importEntries(root: string, sources: string[], toDirRel: string): string[] {
  const projectRoot = resolve(root)
  const toDir = resolveInside(root, toDirRel)
  if (touchesGit(projectRoot, toDir)) throw new Error('Não é possível copiar para dentro do .git.')
  const destination = lstatOrNull(toDir)
  if (!destination) throw missing(`a pasta de destino não existe mais: ${toDirRel || '(raiz do projeto)'}`)
  if (!destination.isDirectory()) throw new Error(`O destino não é uma pasta: ${toDirRel}`)

  const copied: string[] = []
  for (const raw of sources) {
    const source = resolve(raw)
    const stats = lstatOrNull(source)
    if (!stats) throw missing(`o item arrastado não existe: ${raw}`)
    if (relative(dirname(source), toDir) === '') continue
    if (stats.isDirectory() && isSameOrInside(source, toDir)) {
      throw new Error(`Não é possível copiar a pasta "${basename(source)}" para dentro dela mesma.`)
    }
    const target = join(toDir, freeName(toDir, basename(source), stats.isDirectory()))
    cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
    copied.push(relative(projectRoot, target))
  }
  return copied
}
