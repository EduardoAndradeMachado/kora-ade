import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ErrorSummary } from '../shared/ipc'

// Log de erros local para suporte: fica só neste computador e só sai quando o usuário copia ou salva o arquivo.
// Cada entrada começa com uma linha "data [origem] mensagem" e segue com a pilha recuada; o arquivo passa
// de maxBytes e vira errors.old.log (um só guardado), para não crescer sem limite.

export type ErrorSource = 'main' | 'interface' | 'processo'

export interface ErrorLog {
  record(source: ErrorSource, error: unknown, context?: string): void
  summary(): ErrorSummary
  // Últimas entradas inteiras que cabem em maxChars, da mais antiga para a mais nova.
  recent(maxChars: number): string
  // Arquivo único para mandar ao suporte: ambiente, erros e os outros logs do app.
  diagnostic(env: Record<string, string>, extraLogs: { name: string; file: string }[]): string
  readonly file: string
}

const ENTRY_START = /^\d{4}-\d{2}-\d{2}T\S+Z \[/

// Error de verdade (com pilha), mensagem solta ou qualquer coisa jogada: vira texto legível sem quebrar o log.
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

// Logs de fora (updater.log não tem limite): no diagnóstico vai só o fim, que é onde está o problema recente.
const EXTRA_TAIL_BYTES = 256 * 1024

function tail(path: string, bytes: number): string {
  if (!existsSync(path)) return ''
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    if (length === size) return text
    return `(início cortado: últimos ${Math.round(bytes / 1024)} KB)\n${text.slice(text.indexOf('\n') + 1)}`
  } finally {
    closeSync(fd)
  }
}

function entries(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (ENTRY_START.test(line)) out.push(line)
    else if (out.length > 0 && line !== '') out[out.length - 1] += `\n${line}`
  }
  return out
}

export function createErrorLog(options: { dir: string; maxBytes?: number; now?: () => Date }): ErrorLog {
  const maxBytes = options.maxBytes ?? 1_000_000
  const now = options.now ?? (() => new Date())
  const file = join(options.dir, 'errors.log')
  const old = join(options.dir, 'errors.old.log')
  const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')

  return {
    file,
    record(source, error, context) {
      try {
        mkdirSync(options.dir, { recursive: true })
        if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, old)
        const [first = '', ...rest] = errorText(error).split(/\r?\n/)
        const head = `${now().toISOString()} [${source}] ${context ? `${context}: ` : ''}${first}`
        const body = rest.map((line) => `    ${line.trim()}`).join('\n')
        appendFileSync(file, `${head}${body ? `\n${body}` : ''}\n`, 'utf8')
      } catch {
        // Registrar o erro não pode virar outro erro.
      }
    },
    summary() {
      const all = [...entries(read(old)), ...entries(read(file))]
      const last = all.at(-1)
      return { count: all.length, lastAt: last ? last.slice(0, last.indexOf(' ')) : null }
    },
    recent(maxChars) {
      const all = [...entries(read(old)), ...entries(read(file))]
      const picked: string[] = []
      let size = 0
      for (let i = all.length - 1; i >= 0; i--) {
        const entry = all[i]!
        if (size + entry.length + 1 > maxChars && picked.length > 0) break
        picked.unshift(entry)
        size += entry.length + 1
      }
      return picked.join('\n')
    },
    diagnostic(env, extraLogs) {
      const section = (title: string, text: string): string => `===== ${title} =====\n${text.trim() || '(vazio)'}\n`
      return [
        section('Ambiente', Object.entries(env).map(([k, v]) => `${k}: ${v}`).join('\n')),
        section('Erros', [read(old), read(file)].join('')),
        ...extraLogs.map((log) => section(log.name, tail(log.file, EXTRA_TAIL_BYTES)))
      ].join('\n')
    }
  }
}
