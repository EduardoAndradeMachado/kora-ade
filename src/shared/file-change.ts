import type { FilesChange } from './ipc'

// O watcher manda o caminho como o Windows devolve ("src\app.ts"); a aba pode ter vindo com "/" (link do
// terminal, caminho digitado) e com outra caixa, que no NTFS é o mesmo arquivo.
const normalize = (rel: string): string => rel.replace(/\//g, '\\').toLowerCase()

export function touchesFile(change: FilesChange, rel: string): boolean {
  if (change.allFiles || change.rescan) return true
  const target = normalize(rel)
  return change.files.some((f) => normalize(f) === target)
}
