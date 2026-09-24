import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'

// Pasta (relativa ao projeto, '' = raiz) cuja listagem mudou quando `filename` surgiu, sumiu ou foi renomeado.
// Eventos dentro do .git não mexem na árvore, que nem mostra essa pasta.
export function listingDirOf(filename: string): string | null {
  const first = filename.split(/[\\/]/)[0]
  if (!filename || first === '.git') return null
  const dir = dirname(filename)
  return dir === '.' ? '' : dir
}

// Um watcher recursivo por projeto (ReadDirectoryChangesW no Windows). Os eventos chegam em rajadas
// (pnpm install, git checkout) e saem agrupados por pasta depois de um intervalo curto sem novidade.
export class ProjectWatchers {
  private readonly watchers = new Map<string, { watcher: FSWatcher; dirs: Set<string>; timer?: NodeJS.Timeout }>()

  constructor(
    private readonly onChange: (projectId: string, dirs: string[]) => void,
    private readonly quietMs = 150
  ) {}

  watch(projectId: string, root: string): void {
    if (this.watchers.has(projectId)) return
    const entry: { watcher: FSWatcher; dirs: Set<string>; timer?: NodeJS.Timeout } = {
      watcher: watch(root, { recursive: true }, (event, filename) => {
        if (event !== 'rename' || !filename) return
        const dir = listingDirOf(filename.toString())
        if (dir === null) return
        entry.dirs.add(dir)
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          const dirs = [...entry.dirs]
          entry.dirs.clear()
          this.onChange(projectId, dirs)
        }, this.quietMs)
      }),
      dirs: new Set()
    }
    // Pasta do projeto apagada ou sem permissão: para de observar; a árvore mostra o erro na próxima leitura.
    entry.watcher.on('error', () => this.unwatch(projectId))
    this.watchers.set(projectId, entry)
  }

  unwatch(projectId: string): void {
    const entry = this.watchers.get(projectId)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.watcher.close()
    this.watchers.delete(projectId)
  }

  closeAll(): void {
    for (const id of this.watchers.keys()) this.unwatch(id)
  }
}
