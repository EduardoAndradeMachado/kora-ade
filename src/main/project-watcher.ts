import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { FilesChange } from '../shared/ipc'

const NOTHING: FilesChange = { dirs: [], git: false, ignoreRules: false, rescan: false }
const EVERYTHING: FilesChange = { dirs: [], git: true, ignoreRules: true, rescan: true }

// O que um evento do disco muda para a interface. Dentro do .git só importa o que altera o status
// (index, HEAD, refs) e as regras de ignorados (info/exclude); objetos e logs mudam a todo commit sem efeito.
// O status do próprio Kora roda com GIT_OPTIONAL_LOCKS=0 e não regrava o index: reagir a ele não vira laço.
export function classify(event: string, filename: string | null): FilesChange {
  // ReadDirectoryChangesW estourou o buffer (rajada grande): não dá para saber o que mudou.
  if (!filename) return EVERYTHING
  const parts = filename.split(/[\\/]/)
  if (parts[0] === '.git') {
    const inner = parts.slice(1).join('/')
    if (inner.endsWith('.lock')) return NOTHING
    const ignoreRules = inner === 'info/exclude'
    const git = ignoreRules || inner === 'index' || inner === 'HEAD' || inner === 'packed-refs' || inner.startsWith('refs/')
    return git ? { ...NOTHING, git, ignoreRules } : NOTHING
  }
  const dir = dirname(filename)
  return {
    dirs: event === 'rename' ? [dir === '.' ? '' : dir] : [],
    git: true,
    ignoreRules: basename(filename).toLowerCase() === '.gitignore',
    rescan: false
  }
}

const isEmpty = (c: FilesChange): boolean => !c.git && !c.ignoreRules && !c.rescan && c.dirs.length === 0

function merge(a: FilesChange, b: FilesChange): FilesChange {
  return {
    dirs: [...new Set([...a.dirs, ...b.dirs])],
    git: a.git || b.git,
    ignoreRules: a.ignoreRules || b.ignoreRules,
    rescan: a.rescan || b.rescan
  }
}

interface Entry {
  watcher: FSWatcher
  pending: FilesChange
  since: number
  timer?: NodeJS.Timeout
}

// Um watcher recursivo por projeto (ReadDirectoryChangesW no Windows). Os eventos chegam em rajadas
// (pnpm install, git checkout) e saem agrupados depois de um intervalo curto sem novidade; rajada que não
// para (build gravando sem pausa) sai mesmo assim a cada maxWaitMs, para a árvore não ficar parada.
export class ProjectWatchers {
  private readonly watchers = new Map<string, Entry>()

  constructor(
    private readonly onChange: (projectId: string, change: FilesChange) => void,
    private readonly quietMs = 150,
    private readonly maxWaitMs = 1000
  ) {}

  watch(projectId: string, root: string): void {
    if (this.watchers.has(projectId)) return
    const entry: Entry = {
      watcher: watch(root, { recursive: true }, (event, filename) =>
        this.add(projectId, entry, classify(event, filename === null ? null : filename.toString()))
      ),
      pending: NOTHING,
      since: 0
    }
    // Sem watcher a árvore ficaria parada até alguém listar a pasta de novo. O aviso de "releia tudo" faz a
    // interface listar, e a listagem volta a observar (ou mostra o erro, se a pasta do projeto sumiu).
    entry.watcher.on('error', () => {
      this.unwatch(projectId)
      this.onChange(projectId, EVERYTHING)
    })
    this.watchers.set(projectId, entry)
  }

  private add(projectId: string, entry: Entry, change: FilesChange): void {
    if (isEmpty(change)) return
    if (isEmpty(entry.pending)) entry.since = Date.now()
    entry.pending = merge(entry.pending, change)
    clearTimeout(entry.timer)
    const flush = (): void => {
      const pending = entry.pending
      entry.pending = NOTHING
      this.onChange(projectId, pending)
    }
    const waited = Date.now() - entry.since
    entry.timer = setTimeout(flush, waited >= this.maxWaitMs ? 0 : Math.min(this.quietMs, this.maxWaitMs - waited))
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
