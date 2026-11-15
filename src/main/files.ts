import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileEntry, TextFile } from '../shared/ipc'
import { decodeText, detectEncoding, detectEol, encodeText, ENCODING_LABEL, looksBinary, type TextEncodingId } from './text-encoding'
import { replaceFileContents, saveError } from './safe-write'
import { treeStamp, validateEntryName } from './file-actions'
import { OPEN_LIMITS } from '../shared/open-limits'

const isEncodingId = (value: unknown): value is TextEncodingId => typeof value === 'string' && Object.hasOwn(ENCODING_LABEL, value)

const HIDDEN = new Set(['.git'])
// A busca no projeto pula arquivos acima disso: uma ocorrência ali levaria a um arquivo que não abre.
export const MAX_TEXT_BYTES = OPEN_LIMITS.textBytes
// Teto do "Abrir mesmo assim" (a medição está em shared/open-limits). Acima disso, só o programa padrão.
const MAX_FORCED_TEXT_BYTES = OPEN_LIMITS.forcedTextBytes

// O renderer só manda caminhos relativos ao projeto; qualquer coisa que resolva para fora da raiz é recusada.
// Links simbólicos e junções também: um repositório clonado pode trazer um link apontando para fora (o git guarda
// links), e o texto do caminho continuaria "dentro". Vale o caminho real do que existe (para arquivo novo, o da pasta
// mais próxima que já existe).
export function resolveInside(root: string, rel: string): string {
  const target = resolve(root, rel)
  const outside = (base: string, path: string): boolean => {
    const fromRoot = relative(base, path)
    return fromRoot.startsWith('..') || isAbsolute(fromRoot)
  }
  if (outside(resolve(root), target)) throw new Error(`Caminho fora do projeto: ${rel}`)
  if (!existsSync(root)) return target
  let existing = target
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  if (outside(realpathSync.native(root), realpathSync.native(existing))) throw new Error(`Caminho fora do projeto: ${rel}`)
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

// O renderer reconhece as duas mensagens pelo começo: a primeira ganha "Abrir mesmo assim", a segunda não.
// encoding: "Reabrir com codificação", que vale mais que a detecção.
export function readText(root: string, rel: string, opts: { force?: boolean; encoding?: string } = {}): TextFile {
  const file = resolveInside(root, rel)
  if (opts.encoding !== undefined && !isEncodingId(opts.encoding)) throw new Error(`Codificação desconhecida: ${opts.encoding}`)
  const stat = statSync(file)
  if (stat.size > MAX_FORCED_TEXT_BYTES) throw new Error(`Arquivo acima de ${MAX_FORCED_TEXT_BYTES / 1024 / 1024} MB, abra no programa padrão: ${rel}`)
  if (stat.size > MAX_TEXT_BYTES && !opts.force) throw new Error(`Arquivo grande demais para abrir aqui: ${rel}`)
  const bytes = readFileSync(file)
  const encoding = opts.encoding ?? detectEncoding(bytes)
  if (looksBinary(bytes, encoding)) throw new Error(`Arquivo binário, abra no programa padrão: ${rel}`)
  const content = decodeText(bytes, encoding)
  return { content, mtimeMs: stat.mtimeMs, encoding: ENCODING_LABEL[encoding], encodingId: encoding, eol: detectEol(content) }
}

export class ConflictError extends Error {}

function statOrNull(abs: string): Stats | null {
  try {
    return statSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// O Claude/Codex editam os mesmos arquivos em paralelo: salvar por cima de uma versão
// que mudou no disco depois de aberta apagaria o trabalho deles sem aviso.
// A codificação é a que o arquivo tem no disco agora (a mesma que foi lida, já que o mtime bate). Só bytes ASCII
// não dizem se o arquivo é UTF-8 ou Windows-1252 (um salvamento intermediário sem acento apaga a pista): aí vale
// a que o editor leu na abertura. O celular grava sem ela e fica com a do disco.
// forceEncoding: o usuário escolheu a codificação ("Reabrir/Salvar com codificação") e ela vale mais que o disco.
// recreate: o editor do PC mostra a faixa "apagado do disco" e salvar recria; o celular não tem esse aviso e recebe
// o ENOENT de sempre ("não existe mais no PC") em vez de ver o arquivo voltar sem saber.
export function writeText(
  root: string,
  rel: string,
  content: string,
  expectedMtimeMs: number,
  encodingId?: string,
  opts: { recreate?: boolean; forceEncoding?: boolean } = {}
): number {
  const file = resolveInside(root, rel)
  const hint = isEncodingId(encodingId) ? encodingId : undefined
  if (opts.forceEncoding && !hint) throw new Error(`Codificação desconhecida: ${encodingId}`)
  const current = statOrNull(file)
  if (!current) {
    if (!opts.recreate) throw missing(`o arquivo não existe mais: ${rel}`)
    return recreateText(file, rel, content, hint)
  }
  if (current.mtimeMs !== expectedMtimeMs) {
    throw new ConflictError(`O arquivo mudou no disco depois de aberto: ${rel}`)
  }
  let encoding: TextEncodingId
  try {
    encoding = opts.forceEncoding && hint ? hint : encodingOnDisk(file, hint)
  } catch (err) {
    throw saveError(err, rel)
  }
  replaceFileContents(file, encodeText(content, encoding), rel)
  return statSync(file).mtimeMs
}

function encodingOnDisk(file: string, hint: TextEncodingId | undefined): TextEncodingId {
  const bytes = readFileSync(file)
  const onDisk = detectEncoding(bytes)
  return hint && onDisk === 'utf8' && !bytes.some((b) => b >= 0x80) ? hint : onDisk
}

// Apagado ou movido depois de aberto: não há versão de ninguém no disco para proteger, então salvar recria
// (com a pasta, se ela também sumiu), na codificação que o editor leu; sem ela, UTF-8 (com BOM se o texto tiver).
// 'wx' não sobrescreve quem recriar o arquivo entre a checagem e a gravação.
function recreateText(file: string, rel: string, content: string, encoding?: TextEncodingId): number {
  encoding ??= content.startsWith('﻿') ? 'utf8bom' : 'utf8'
  refuseUncreatableNames(file, rel)
  mkdirSync(dirname(file), { recursive: true })
  try {
    writeFileSync(file, encodeText(content, encoding), { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConflictError(`O arquivo mudou no disco depois de aberto: ${rel}`)
    }
    throw err
  }
  return statSync(file).mtimeMs
}

// O Node cria de verdade "nul", "con.txt" e "nome." (sem passar pelas regras do Win32), e o Explorer não consegue
// abrir, renomear nem apagar o que fica. Só os nomes que esta gravação criaria: pasta que já existe fica como está.
function refuseUncreatableNames(file: string, rel: string): void {
  for (let path = file; !existsSync(path) && dirname(path) !== path; path = dirname(path)) {
    const name = basename(path)
    try {
      // validateEntryName apara as pontas antes de olhar: "nome " passaria como "nome".
      if (/[. ]$/.test(name)) throw new Error('O nome não pode terminar com ponto ou espaço.')
      validateEntryName(name)
    } catch (err) {
      throw new Error(`Não foi possível recriar ${rel}: ${(err as Error).message}`)
    }
  }
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

const isTakenError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST'
}

// Uma cópia por vez: o nome livre é escolhido antes de copiar, e duas colagens juntas escolheriam o mesmo "nome (2)".
let copyQueue: Promise<unknown> = Promise.resolve()

// Assíncrona porque roda no processo dos terminais: colar uma pasta grande não pode congelar o app.
export const copyItem = (source: string, target: string): Promise<void> => cp(source, target, { recursive: true, errorOnExist: true, force: false })

export function copyInto(
  root: string,
  sources: string[],
  toDirRel: string,
  sameFolder: 'skip' | 'duplicate',
  copy: (source: string, target: string) => Promise<void> = copyItem
): Promise<string[]> {
  const run = copyQueue.then(() => copyIntoNow(root, sources, toDirRel, sameFolder, copy))
  copyQueue = run.catch(() => {})
  return run
}

// Confere todas as origens antes da primeira cópia; se a cópia falhar no meio (arquivo travado, disco cheio), apaga o
// que esta operação já criou: os destinos tinham nomes livres, então nada que existia antes é tocado. Cópia já
// terminada que mudou depois (um agente começou a trabalhar nela enquanto a próxima copiava) fica, e o erro diz qual.
async function copyIntoNow(
  root: string,
  sources: string[],
  toDirRel: string,
  sameFolder: 'skip' | 'duplicate',
  copy: (source: string, target: string) => Promise<void>
): Promise<string[]> {
  const projectRoot = resolve(root)
  const toDir = resolveInside(root, toDirRel)
  if (touchesGit(projectRoot, toDir)) throw new Error('Não é possível copiar para dentro do .git.')
  const destination = lstatOrNull(toDir)
  if (!destination) throw missing(`a pasta de destino não existe mais: ${toDirRel || '(raiz do projeto)'}`)
  if (!destination.isDirectory()) throw new Error(`O destino não é uma pasta: ${toDirRel}`)

  const planned: { source: string; isDir: boolean }[] = []
  for (const source of sources) {
    const stats = lstatOrNull(source)
    if (!stats) throw missing(`o item não existe mais: ${source}`)
    if (sameFolder === 'skip' && relative(dirname(source), toDir) === '') continue
    if (stats.isDirectory() && isSameOrInside(source, toDir)) {
      throw new Error(`Não é possível copiar a pasta "${basename(source)}" para dentro dela mesma.`)
    }
    planned.push({ source, isDir: stats.isDirectory() })
  }
  const created: string[] = []
  const stamps = new Map<string, string>()
  try {
    for (const { source, isDir } of planned) {
      const target = join(toDir, freeName(toDir, basename(source), isDir))
      created.push(target)
      try {
        await copy(source, target)
        const stamp = await treeStamp(projectRoot, relative(projectRoot, target)).catch(() => null)
        if (stamp !== null) stamps.set(target, stamp)
      } catch (err) {
        // Outro programa pegou o nome entre a escolha e a cópia (o errorOnExist recusa): o que está lá é dele e fica
        // fora da limpeza. EEXIST de um item lá dentro é conflito na cópia desta operação, que é apagada.
        const at = (err as { path?: unknown }).path
        if (isTakenError(err) && typeof at === 'string' && resolve(at).toLowerCase() === target.toLowerCase()) created.pop()
        throw err
      }
    }
  } catch (err) {
    const kept: string[] = []
    for (const target of created) {
      const stamp = stamps.get(target)
      if (stamp !== undefined && (await treeStamp(projectRoot, relative(projectRoot, target)).catch(() => null)) !== stamp) {
        kept.push(relative(projectRoot, target))
      } else await rm(target, { recursive: true, force: true })
    }
    if (kept.length === 0) throw err
    throw Object.assign(new Error(`${(err as Error).message}
Ficou no projeto, porque foi alterado depois de copiado: ${kept.join(', ')}`), {
      code: (err as NodeJS.ErrnoException).code
    })
  }
  return created.map((target) => relative(projectRoot, target))
}

// Arquivos e pastas soltos de fora do app (Explorer do Windows) entram no projeto como cópia: o original fica
// onde estava, como no VS Code. Nada é sobrescrito; item que já está nessa mesma pasta é ignorado.
export function importEntries(root: string, sources: string[], toDirRel: string): Promise<string[]> {
  return copyInto(root, sources.map((raw) => resolve(raw)), toDirRel, 'skip')
}

// Colar e duplicar dentro do projeto: na mesma pasta vira "nome (2).ext", como o Windows faz.
export async function copyEntries(root: string, fromRels: string[], toDirRel: string): Promise<string[]> {
  const projectRoot = resolve(root)
  const sources = fromRels.map((rel) => {
    const source = resolveInside(root, rel)
    if (relative(projectRoot, source) === '') throw new Error('Não é possível copiar a raiz do projeto.')
    if (touchesGit(projectRoot, source)) throw new Error('Não é possível copiar o .git.')
    return source
  })
  return copyInto(root, sources, toDirRel, 'duplicate')
}
