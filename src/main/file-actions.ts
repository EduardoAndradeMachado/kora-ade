import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { missing, MoveConflictError, resolveInside, touchesGit } from './files'

// Caracteres de controle também são proibidos em nomes de arquivo no Windows.
// oxlint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function validateEntryName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new Error('Nome vazio ou inválido.')
  if (INVALID_CHARS.test(trimmed)) throw new Error('O nome não pode conter < > : " / \\ | ? *')
  // O Windows remove ponto/espaço no fim e recusa nomes de dispositivo, criando algo diferente do pedido.
  if (/[. ]$/.test(trimmed)) throw new Error('O nome não pode terminar com ponto ou espaço.')
  if (RESERVED.test(trimmed)) throw new Error(`"${trimmed}" é um nome reservado do Windows.`)
  return trimmed
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

export function createEntry(root: string, parentRel: string, name: string, kind: 'file' | 'dir'): string {
  const valid = validateEntryName(name)
  const rel = parentRel ? join(parentRel, valid) : valid
  const target = resolveInside(root, rel)
  if (existsSync(target)) throw new Error(`Já existe "${valid}" nessa pasta.`)
  if (kind === 'dir') mkdirSync(target)
  else writeFileSync(target, '', { flag: 'wx' })
  return rel
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
