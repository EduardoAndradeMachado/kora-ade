import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolveInside } from './files'
import { GitError, projectRel, toGitPath } from './git'

// Âncora "/" no começo: "build" sozinho ignoraria qualquer "build" em qualquer pasta. Pasta ganha "/" no fim.
// Os curingas e a barra invertida viram literais; espaço no fim de linha o git descarta, a não ser escapado.
export function ignorePattern(gitPath: string, isDir: boolean): string {
  const escaped = gitPath.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '))
  return `/${escaped}${isDir ? '/' : ''}`
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Usa o .gitignore da pasta do projeto (mesmo quando o repositório começa acima dela: o git lê .gitignore de
// subpastas, e nada fora do projeto é alterado). Mantém o fim de linha do arquivo e não repete linha que já existe.
export function gitAddToIgnore(root: string, paths: readonly string[]): string[] {
  if (paths.length === 0) throw new GitError('Nenhum arquivo informado.', null, '')
  const patterns = paths.map((p) => {
    const rel = projectRel(root, p)
    if (toGitPath(rel).toLowerCase() === '.gitignore') throw new GitError('O próprio .gitignore não pode ser ignorado por aqui.', null, '')
    return ignorePattern(toGitPath(rel), isDirectory(resolveInside(root, rel)))
  })
  // resolveInside segue o link: ".gitignore" que é link para fora do projeto é recusado em vez de gravado lá.
  let file: string
  try {
    file = resolveInside(root, '.gitignore')
  } catch {
    throw new GitError('O ".gitignore" deste projeto é um link para fora do projeto; edite-o direto.', null, '')
  }
  if (isDirectory(file)) throw new GitError('".gitignore" é uma pasta neste projeto.', null, '')
  const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const existing = new Set(content.split(/\r?\n/).map((line) => line.replace(/(?<!\\) +$/, '')))
  const added: string[] = []
  for (const pattern of patterns) {
    if (existing.has(pattern)) continue
    existing.add(pattern)
    added.push(pattern)
  }
  if (added.length === 0) return []
  const separator = content === '' || content.endsWith('\n') ? '' : eol
  writeFileSync(file, content + separator + added.join(eol) + eol, 'utf8')
  return added
}
