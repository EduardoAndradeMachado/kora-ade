import { readdir, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { MobileFolders } from '../shared/mobile'

export function isMobileDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

export async function mobileDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || path.startsWith('\\\\')) throw new Error('Escolha uma pasta local do PC usando o caminho completo.')
  const resolved = resolve(path)
  if (!(await stat(resolved).catch(() => null))?.isDirectory()) throw new Error('Pasta não encontrada no PC. Escolha outra pasta.')
  return resolved
}

export async function browseMobileFolders(path: string | undefined, projectPaths: string[]): Promise<MobileFolders> {
  const home = homedir()
  const current = await mobileDirectory(path || home)
  const candidates = [
    { name: 'Pasta pessoal', path: home },
    { name: 'Documentos', path: join(home, 'Documents') },
    { name: 'Área de trabalho', path: join(home, 'Desktop') },
    ...[...new Set(projectPaths.map(dirname))].map((path) => ({ name: 'Projetos · ' + path.split(/[\\/]/).at(-1), path })),
    ...(process.platform === 'win32' ? Array.from({ length: 26 }, (_, index) => ({ name: `Disco ${String.fromCharCode(65 + index)}:`, path: `${String.fromCharCode(65 + index)}:\\` })) : [{ name: 'Sistema', path: '/' }])
  ]
  const available = await Promise.all(candidates.map(async (entry) => (await stat(entry.path).catch(() => null))?.isDirectory() ? entry : null))
  const seen = new Set<string>()
  const shortcuts = available.filter((entry): entry is { name: string; path: string } => {
    if (!entry || seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
  const entries = await readdir(current, { withFileTypes: true }).catch(() => { throw new Error('Não foi possível abrir esta pasta. Verifique a permissão no PC.') })
  return {
    path: current, parent: dirname(current) === current ? null : dirname(current), shortcuts,
    folders: entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: join(current, entry.name) })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }))
  }
}
