import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { splitLineSuffix } from '../shared/terminal-links'

export interface ResolvedLink {
  rel: string
  line: number | null
}

// Só vira link o arquivo que existe dentro do projeto; caminho fora dele (ou pasta) fica como texto comum.
export async function resolveTerminalLink(root: string, text: string): Promise<ResolvedLink | null> {
  const { path, line } = splitLineSuffix(text.trim())
  if (!path) return null
  const projectRoot = resolve(root)
  const absolute = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path)
  const rel = relative(projectRoot, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  try {
    if (!(await stat(absolute)).isFile()) return null
  } catch {
    return null
  }
  return { rel, line }
}
