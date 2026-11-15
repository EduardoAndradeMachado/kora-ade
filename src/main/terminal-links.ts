import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { splitLineSuffix } from '../shared/terminal-links'

export interface ResolvedLink {
  rel: string
  line: number | null
}

const insideRel = (root: string, absolute: string): string | null => {
  const rel = relative(root, absolute)
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : rel
}

const isFile = async (absolute: string): Promise<boolean> => {
  try {
    return (await stat(absolute)).isFile()
  } catch {
    return false
  }
}

// Só vira link o arquivo que existe dentro do projeto; caminho fora dele (ou pasta) fica como texto comum.
// dir: pasta do terminal (relativa ao projeto). O que ele imprime é relativo a ela; o que não existir lá ainda pode
// ser relativo à raiz (o agente costuma citar caminhos a partir dela).
export async function resolveTerminalLink(root: string, text: string, dir?: string): Promise<ResolvedLink | null> {
  const { path, line } = splitLineSuffix(text.trim())
  if (!path) return null
  const projectRoot = resolve(root)
  const bases = isAbsolute(path) || !dir ? [projectRoot] : [resolve(projectRoot, dir), projectRoot]
  for (const base of bases) {
    const absolute = resolve(base, path)
    const rel = insideRel(projectRoot, absolute)
    if (rel !== null && (await isFile(absolute))) return { rel, line }
  }
  return null
}
