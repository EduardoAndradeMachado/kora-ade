import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { entryNameProblem, parseEntryPath } from '../shared/entry-name'
import type { TreeUndoResult, TreeUndoStep } from '../shared/ipc'
import { missing, MoveConflictError, resolveInside, touchesGit } from './files'
import { findTrashed, restoreTrashed, type TrashedItem } from './recycle-bin'

export function validateEntryName(name: string): string {
  const problem = entryNameProblem(name)
  if (problem) throw new Error(problem)
  return name.trim()
}

export function renameEntry(root: string, rel: string, newName: string): string {
  const valid = validateEntryName(newName)
  const projectRoot = resolve(root)
  const from = resolveInside(root, rel)
  if (relative(projectRoot, from) === '') throw new Error('Não é possível renomear a raiz do projeto.')
  if (touchesGit(projectRoot, from) || valid.toLowerCase() === '.git') throw new Error('Não é possível renomear para ou dentro do .git.')
  if (!existsSync(from)) throw missing(`o item não existe mais: ${rel}`)
  const target = join(dirname(from), valid)
  if (target === from) return relative(projectRoot, from)
  // Só mudar maiúsculas ("readme" → "README") é o mesmo item para o Windows: existsSync diria que já existe.
  const onlyCase = target.toLowerCase() === from.toLowerCase()
  if (!onlyCase && existsSync(target)) throw new MoveConflictError(`Já existe "${valid}" nessa pasta.`)
  renameSync(from, target)
  return relative(projectRoot, target)
}

// Vai para a Lixeira em vez de apagar: um clique (ou toque) errado tem volta. `trash` é o shell.trashItem do Electron.
// A raiz é conferida pelo caminho resolvido, não pelo texto: "." e "a/.." também são a raiz.
export async function trashEntry(root: string, rel: string, trash: (abs: string) => Promise<void>): Promise<void> {
  const projectRoot = resolve(root)
  const target = resolveInside(root, rel)
  if (relative(projectRoot, target) === '') throw new Error('A pasta do projeto não pode ser excluída por aqui.')
  if (touchesGit(projectRoot, target)) throw new Error('Não é possível excluir o .git.')
  if (!statOrNull(target)) throw missing(`o item não existe mais: ${rel}`)
  await trash(target)
}

// "a/b/c.ts" (ou com \) cria as pastas que faltam, como o VS Code.
export function splitEntryPath(input: string): string[] {
  const parsed = parseEntryPath(input)
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.parts
}

// `top` é o primeiro item que não existia: desfazer manda só ele para a Lixeira, levando as pastas criadas junto.
export function createEntry(root: string, parentRel: string, name: string, kind: 'file' | 'dir'): { rel: string; top: string } {
  const parts = splitEntryPath(name)
  const projectRoot = resolve(root)
  const rels = parts.map((_, i) => join(parentRel, ...parts.slice(0, i + 1)))
  const targets = rels.map((rel) => resolveInside(root, rel))
  if (targets.some((target) => touchesGit(projectRoot, target))) throw new Error('Não é possível criar no .git.')
  // Confere tudo antes de criar a primeira pasta: um conflito no fim não deixa pastas soltas pelo caminho.
  let first = 0
  for (; first < targets.length; first++) {
    const stats = statOrNull(targets[first]!)
    if (!stats) break
    if (first === targets.length - 1) {
      const where = first === 0 ? 'nessa pasta' : `em "${parts.slice(0, first).join('/')}"`
      throw new Error(`Já existe "${parts[first]}" ${where}.`)
    }
    if (!stats.isDirectory()) throw new Error(`"${parts.slice(0, first + 1).join('/')}" é um arquivo, não uma pasta.`)
  }
  // Falha depois disso (nome longo demais, permissão, um agente criou o mesmo nome no meio) desfaz as pastas que esta
  // chamada criou; rmdirSync só apaga pasta vazia, então nada que outro processo tenha posto nelas se perde.
  const made: string[] = []
  try {
    for (let i = first; i < targets.length - 1; i++) {
      mkdirSync(targets[i]!)
      made.push(targets[i]!)
    }
    const target = targets[targets.length - 1]!
    if (kind === 'dir') mkdirSync(target)
    else writeFileSync(target, '', { flag: 'wx' })
  } catch (err) {
    for (const dir of made.reverse()) {
      try {
        rmdirSync(dir)
      } catch {
        // Não está vazia: alguém escreveu nela no meio, fica.
      }
    }
    throw err
  }
  return { rel: rels[rels.length - 1]!, top: rels[first]! }
}

function statOrNull(abs: string): Stats | null {
  try {
    return lstatSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT'
// Segue junção: projeto aberto por uma junção tem a raiz como link, e o lstat dela não diz "pasta".
const isDirAt = (abs: string): boolean => statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false

// Retrato do que a árvore acabou de criar ou colar: desfazer só apaga se o item continua exatamente assim. Arquivo
// salvo depois (por você ou por um agente) muda tamanho ou data e o desfazer recusa em vez de levar a alteração junto.
// Assíncrono: uma pasta colada pode ter milhares de itens, e o processo main é o mesmo dos terminais.
export async function treeStamp(root: string, rel: string): Promise<string> {
  const hash = createHash('sha1')
  const walk = async (abs: string, sub: string): Promise<void> => {
    const stats = await lstat(abs).catch((err: unknown) => {
      if (isMissing(err)) return null
      throw err
    })
    if (!stats) hash.update(`${sub}|-\n`)
    else if (stats.isDirectory()) {
      hash.update(`${sub}|d\n`)
      const names = await readdir(abs).catch((err: unknown) => {
        if (isMissing(err)) return []
        throw err
      })
      for (const name of names.sort()) await walk(join(abs, name), join(sub, name))
    } else hash.update(`${sub}|${stats.size}|${stats.mtimeMs}\n`)
  }
  await walk(resolveInside(root, rel), '')
  return hash.digest('hex')
}

const nameOf = (rel: string): string => basename(rel) || rel
const errorText = (rel: string, err: unknown): string => `"${nameOf(rel)}": ${(err as Error).message}`

function restOf(step: TreeUndoStep, from: number): TreeUndoStep {
  if (step.kind === 'move') return { kind: 'move', moves: step.moves.slice(from) }
  if (step.kind === 'remove') return { kind: 'remove', items: step.items.slice(from) }
  return { kind: 'restore', items: step.items.slice(from) }
}

export const TreeUndoStepSchema: z.ZodType<TreeUndoStep> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remove'), items: z.array(z.object({ rel: z.string().min(1), stamp: z.string() })).min(1) }),
  z.object({ kind: z.literal('move'), moves: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).min(1) }),
  z.object({ kind: z.literal('restore'), items: z.array(z.object({ rel: z.string().min(1), since: z.number() })).min(1) })
])

// Confere o passo inteiro antes de mexer no primeiro item (recusa sem tocar em nada) e de novo cada item logo antes de
// agir nele: enquanto o anterior ia para a Lixeira, um agente pode ter salvo o próximo. Falha no meio devolve em
// `remaining` só o que faltou, para a árvore tentar de novo sem refazer o que já foi.
export async function undoTreeStep(root: string, step: TreeUndoStep, trash: (abs: string) => Promise<void>): Promise<TreeUndoResult> {
  const projectRoot = resolve(root)
  const refuse = (message: string): TreeUndoResult => ({ moved: [], message, remaining: step })
  const stopAt = (index: number, message: string, moved: TreeUndoResult['moved'] = []): TreeUndoResult => ({
    moved,
    message,
    remaining: restOf(step, index)
  })
  const done = (moved: TreeUndoResult['moved'] = []): TreeUndoResult => ({ moved, message: null, remaining: null })

  if (step.kind === 'remove') {
    const problem = async ({ rel, stamp }: { rel: string; stamp: string }): Promise<string | null> => {
      if (!statOrNull(resolveInside(root, rel))) return `"${nameOf(rel)}" não existe mais.`
      if ((await treeStamp(root, rel)) !== stamp) {
        return `"${nameOf(rel)}" foi alterado depois; desfazer levaria a alteração junto. Use Excluir se quiser apagar.`
      }
      return null
    }
    for (const item of step.items) {
      const reason = await problem(item)
      if (reason) return refuse(reason)
    }
    for (const [i, item] of step.items.entries()) {
      const reason = await problem(item)
      if (reason) return stopAt(i, reason)
      try {
        await trash(resolveInside(root, item.rel))
      } catch (err) {
        return stopAt(i, errorText(item.rel, err))
      }
    }
    return done()
  }

  if (step.kind === 'move') {
    const problem = ({ from, to }: { from: string; to: string }): string | null => {
      const original = resolveInside(root, from)
      const current = resolveInside(root, to)
      if (touchesGit(projectRoot, original) || touchesGit(projectRoot, current)) return 'Não é possível mexer no .git.'
      if (!statOrNull(current)) return `"${nameOf(to)}" não existe mais.`
      if (!isDirAt(dirname(original))) return `A pasta de onde "${nameOf(from)}" saiu não existe mais.`
      const onlyCase = original.toLowerCase() === current.toLowerCase()
      if (!onlyCase && statOrNull(original)) return `Já existe outro "${nameOf(from)}" no lugar de antes.`
      return null
    }
    for (const move of step.moves) {
      const reason = problem(move)
      if (reason) return refuse(reason)
    }
    const moved: TreeUndoResult['moved'] = []
    for (const [i, move] of step.moves.entries()) {
      const reason = problem(move)
      if (reason) return stopAt(i, reason, moved)
      try {
        renameSync(resolveInside(root, move.to), resolveInside(root, move.from))
        moved.push({ from: move.to, to: move.from })
      } catch (err) {
        return stopAt(i, errorText(move.to, err), moved)
      }
    }
    return done(moved)
  }

  const problem = (rel: string): string | null => {
    const original = resolveInside(root, rel)
    if (statOrNull(original)) return `Já existe outro "${nameOf(rel)}" no lugar de antes.`
    if (!isDirAt(dirname(original))) return `A pasta de onde "${nameOf(rel)}" saiu não existe mais.`
    return null
  }
  const found: TrashedItem[] = []
  for (const { rel, since } of step.items) {
    const reason = problem(rel)
    if (reason) return refuse(reason)
    const item = findTrashed(resolveInside(root, rel), since)
    if (!item) return refuse(`"${nameOf(rel)}" não está mais na Lixeira do Windows.`)
    found.push(item)
  }
  for (const [i, item] of found.entries()) {
    const { rel } = step.items[i]!
    const reason = problem(rel) ?? (existsSync(item.data) ? null : `"${nameOf(rel)}" não está mais na Lixeira do Windows.`)
    if (reason) return stopAt(i, reason)
    try {
      restoreTrashed(item)
    } catch (err) {
      return stopAt(i, errorText(rel, err))
    }
  }
  return done()
}

export interface BrowserCommand {
  exe: string
  args: string[]
}

// Formato do registro: "C:\...\chrome.exe" --single-argument %1  |  C:\...\firefox.exe -osint -url "%1"
export function browserCommandFor(template: string, url: string): BrowserCommand {
  const match = /^\s*(?:"([^"]+)"|(\S+))\s*(.*)$/.exec(template)
  if (!match) throw new Error(`Comando do navegador não reconhecido: ${template}`)
  const exe = match[1] ?? match[2]!
  const rest = (match[3] ?? '').match(/"[^"]*"|\S+/g) ?? []
  const args = rest.map((a) => a.replace(/^"(.*)"$/, '$1'))
  const hasPlaceholder = args.some((a) => a.includes('%1'))
  return { exe, args: hasPlaceholder ? args.map((a) => a.replace('%1', url)) : [...args, url] }
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  )

export function parseRegValue(output: string): string | null {
  const line = output.split(/\r?\n/).find((l) => /\sREG_(EXPAND_)?SZ\s/.test(l))
  return line ? line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/, '').trim() : null
}

export async function defaultBrowserTemplate(): Promise<string> {
  const choice = await run('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v',
    'ProgId'
  ])
  const progId = parseRegValue(choice)
  if (!progId) throw new Error('Navegador padrão não encontrado no registro.')
  const command = parseRegValue(await run('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']))
  if (!command) throw new Error(`Comando do navegador ${progId} não encontrado.`)
  return command
}

export async function openInDefaultBrowser(file: string): Promise<void> {
  const { exe, args } = browserCommandFor(await defaultBrowserTemplate(), pathToFileURL(file).href)
  const { spawn } = await import('node:child_process')
  spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
}
