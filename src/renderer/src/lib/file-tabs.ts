import { viewerFor, type Viewer } from '../../../shared/file-kind'
import type { FilesChange } from '../../../shared/ipc'

export interface FileTab {
  kind: 'file'
  id: string
  title: string
  path: string
  viewer: Viewer
  editing: boolean
  // Markdown com editor e visualização lado a lado (editing continua true).
  split?: boolean
  dirty: boolean
  // Pedido de ir até uma linha (ex.: Ctrl+clique em "src/a.ts:42" no terminal); n muda a cada pedido. column e
  // length (UTF-16, column a partir de 1) marcam o trecho a selecionar, como a ocorrência de um resultado da busca.
  jump?: { line: number; n: number; column?: number; length?: number }
  // Último pedido de abrir esta aba: focus false (clique simples na árvore ou na busca) deixa o foco onde estava;
  // n muda a cada pedido, e trocar de aba depois volta a focar o editor.
  focusRequest?: { n: number; focus: boolean }
  // Aba de diff do git (só leitura) em vez do arquivo: staged compara HEAD com a fila, senão a fila com o disco.
  // Com `commit`, o arquivo naquele commit contra o primeiro pai (`origPath`: o nome antes do rename);
  // com `fileAt`, só o conteúdo do arquivo em `commit`, sem diff ("Abrir arquivo (HEAD)").
  diff?: GitDiffTarget
  // Comparação de dois arquivos do projeto: `left` só leitura, `path` (o da direita) editável e salvável.
  compare?: { left: string }
  // Pré-visualização (título em itálico): o próximo arquivo aberto com clique simples toma o lugar dela.
  preview?: boolean
  // O arquivo sumiu do disco com a aba aberta; a aba fica, riscada, e volta ao normal se ele reaparecer.
  deleted?: boolean
}

export interface GitDiffTarget {
  staged: boolean
  commit?: string
  origPath?: string
  fileAt?: boolean
}

// O que o painel do Git e o histórico pedem além de staged: preview no clique simples, fixa no duplo clique.
export type GitDiffOpen = Omit<GitDiffTarget, 'staged'> & { preview?: boolean }

// Abrir pela árvore ou pela busca: clique simples abre em pré-visualização sem tirar o foco da lista (focus false);
// Enter e duplo clique abrem fixa e passam o foco ao editor. Sem focus, o editor recebe o foco.
export interface OpenFileOptions {
  preview?: boolean
  focus?: boolean
}

// Resultado da busca: coluna (a partir de 1) e tamanho da ocorrência, em unidades UTF-16.
export interface OpenAtOptions extends OpenFileOptions {
  column?: number
  length?: number
}

type Listed = { kind: string; id: string }

const isFileTab = <T extends Listed>(tab: T): tab is T & FileTab =>
  tab.kind === 'file' && !(tab as unknown as FileTab).diff && !(tab as unknown as FileTab).compare

const titleOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

// Aba de arquivo aberta pela árvore, pelo Ctrl+P ou pelo terminal. Pré-visualização (clique simples) ocupa a
// aba de pré-visualização do projeto em vez de somar outra; a aba que já tem o arquivo só é selecionada, e
// pedir o arquivo sem pré-visualização fixa essa aba. A aba suja nunca é trocada: perderia a edição.
export function placeFileTab<T extends Listed>(
  list: readonly T[],
  request: { projectId: string; path: string; viewer: Viewer; preview: boolean },
  isDirty: (tab: FileTab) => boolean
): { list: (T | FileTab)[]; id: string } {
  const { projectId, path, viewer, preview } = request
  const existing = list.find((t) => isFileTab(t) && t.path === path) as (T & FileTab) | undefined
  if (existing) {
    if (preview || !existing.preview) return { list: [...list], id: existing.id }
    return { list: list.map((t) => (t === existing ? { ...existing, preview: false } : t)), id: existing.id }
  }
  // Aba movida (renomear na árvore) guarda o id do caminho antigo; o arquivo novo nesse caminho precisa de outro.
  const base = `file:${projectId}:${path}`
  let id = base
  for (let n = 2; list.some((t) => t.id === id); n++) id = `${base}:${n}`
  const tab: FileTab = { kind: 'file', id, title: titleOf(path), path, viewer, editing: viewer === 'code', dirty: false, preview }
  const reusable = preview ? previewSlot(list, isDirty) : undefined
  if (reusable) return { list: list.map((t) => (t === reusable ? tab : t)), id }
  return { list: [...list, tab], id }
}

// Uma vaga de pré-visualização por projeto, dividida entre arquivo e diff do git, como no editor do VS Code.
function previewSlot<T extends Listed>(list: readonly T[], isDirty: (tab: FileTab) => boolean): (T & FileTab) | undefined {
  return list.find((t) => {
    const tab = t as unknown as FileTab
    return t.kind === 'file' && tab.preview === true && !tab.compare && !isDirty(tab)
  }) as (T & FileTab) | undefined
}

const sameDiff = (a: GitDiffTarget | undefined, b: GitDiffTarget | undefined): boolean =>
  a?.staged === b?.staged && a?.commit === b?.commit && Boolean(a?.fileAt) === Boolean(b?.fileAt)

const shortHash = (hash: string): string => (/^[0-9a-f]{8,}$/i.test(hash) ? hash.slice(0, 7) : hash)

export function diffTitle(path: string, target: GitDiffTarget): string {
  const name = titleOf(path)
  const renamed = target.origPath && titleOf(target.origPath) !== name ? `${titleOf(target.origPath)} ↔ ${name}` : name
  if (target.commit) return `${target.fileAt ? name : renamed} (${shortHash(target.commit)})`
  return `${renamed} (${target.staged ? 'na fila' : 'alterações'})`
}

// Diff aberto pelo painel do Git ou pelo histórico: mesma regra de pré-visualização das abas de arquivo.
export function placeDiffTab<T extends Listed>(
  list: readonly T[],
  request: { projectId: string; path: string; target: GitDiffTarget; preview: boolean },
  isDirty: (tab: FileTab) => boolean
): { list: (T | FileTab)[]; id: string } {
  const { projectId, path, target, preview } = request
  const existing = list.find((t) => {
    const tab = t as unknown as FileTab
    return t.kind === 'file' && tab.path === path && tab.diff !== undefined && sameDiff(tab.diff, target)
  }) as (T & FileTab) | undefined
  if (existing) {
    if (preview || !existing.preview) return { list: [...list], id: existing.id }
    return { list: list.map((t) => (t === existing ? { ...existing, preview: false } : t)), id: existing.id }
  }
  const kind = target.commit ? `${target.fileAt ? 'at' : 'commit'}:${target.commit}` : target.staged ? 'staged' : 'working'
  const id = uniqueId(list, `diff:${kind}:${projectId}:${path}`)
  const diff: GitDiffTarget = { staged: target.staged }
  if (target.commit) diff.commit = target.commit
  if (target.origPath) diff.origPath = target.origPath
  if (target.fileAt) diff.fileAt = true
  const tab: FileTab = { kind: 'file', id, title: diffTitle(path, diff), path, viewer: 'code', editing: false, dirty: false, diff, preview }
  const reusable = preview ? previewSlot(list, isDirty) : undefined
  if (reusable) return { list: list.map((t) => (t === reusable ? tab : t)), id }
  return { list: [...list, tab], id }
}

export type CloseScope = 'others' | 'right' | 'saved' | 'all'

// Os fechamentos em lote do menu da aba só alcançam abas de arquivo (diffs inclusive); terminais ficam.
export function fileTabsToClose<T extends Listed>(
  list: readonly T[],
  targetId: string,
  scope: CloseScope,
  isDirty: (tab: FileTab) => boolean
): string[] {
  const at = list.findIndex((t) => t.id === targetId)
  const files = list.flatMap((t, index) => (t.kind === 'file' ? [{ tab: t as T & FileTab, index }] : []))
  const pick = (keep: (f: { tab: FileTab; index: number }) => boolean): string[] => files.filter(keep).map((f) => f.tab.id)
  switch (scope) {
    case 'others':
      return pick((f) => f.tab.id !== targetId)
    case 'right':
      return at < 0 ? [] : pick((f) => f.index > at)
    case 'saved':
      return pick((f) => !isDirty(f.tab))
    case 'all':
      return pick(() => true)
  }
}

const parentName = (path: string): string => path.split(/[\\/]/).slice(0, -1).pop() ?? ''

// Nomes iguais (index.ts ↔ index.ts) não dizem qual lado é qual: aí entra a pasta de cada um.
export function compareTitle(left: string, right: string): string {
  const [a, b] = [titleOf(left), titleOf(right)]
  if (a.toLowerCase() !== b.toLowerCase()) return `${a} ↔ ${b}`
  const [pa, pb] = [parentName(left), parentName(right)]
  if (pa.toLowerCase() === pb.toLowerCase()) return `${left} ↔ ${right}`
  return `${pa ? `${pa}\\` : ''}${a} ↔ ${pb ? `${pb}\\` : ''}${b}`
}

const uniqueId = (list: readonly Listed[], base: string): string => {
  let id = base
  for (let n = 2; list.some((t) => t.id === id); n++) id = `${base}:${n}`
  return id
}

// A mesma dupla, na mesma ordem, volta para a aba que já existe; invertida é outra comparação (o lado editável muda).
export function placeCompareTab<T extends Listed>(
  list: readonly T[],
  request: { projectId: string; left: string; right: string }
): { list: (T | FileTab)[]; id: string } {
  const { projectId, left, right } = request
  const existing = list.find((t) => t.kind === 'file' && (t as unknown as FileTab).compare?.left === left && (t as unknown as FileTab).path === right)
  if (existing) return { list: [...list], id: existing.id }
  const id = uniqueId(list, `compare:${projectId}:${left}|${right}`)
  const tab: FileTab = { kind: 'file', id, title: compareTitle(left, right), path: right, viewer: 'code', editing: true, dirty: false, compare: { left } }
  return { list: [...list, tab], id }
}

const isUnder = (path: string, rel: string): boolean =>
  path === rel || path.startsWith(`${rel}\\`) || path.startsWith(`${rel}/`)
const movedPath = (path: string, from: string, to: string): string => (isUnder(path, from) ? to + path.slice(from.length) : path)

// A aba mostra algo de dentro de rel? Decide se mover ou renomear rel pode levar uma edição não salva junto.
export function tabShowsPathUnder(tab: FileTab, rel: string): boolean {
  return isUnder(tab.path, rel) || (tab.compare !== undefined && isUnder(tab.compare.left, rel))
}

// Renomear ou mover na árvore leva junto a aba do caminho, ou de dentro da pasta movida; na comparação, os dois lados.
export function moveFileTab(tab: FileTab, from: string, to: string): FileTab {
  const path = movedPath(tab.path, from, to)
  const left = tab.compare && movedPath(tab.compare.left, from, to)
  if (path === tab.path && left === tab.compare?.left) return tab
  if (left !== undefined) return { ...tab, path, compare: { left }, title: compareTitle(left, path), deleted: false }
  // Mesma extensão mantém o visualizador escolhido (ex.: "Abrir como texto"); outra extensão pega o dela.
  const viewer = viewerFor(path) === viewerFor(tab.path) ? tab.viewer : viewerFor(path)
  return { ...tab, path, title: titleOf(path), viewer, deleted: false }
}

// Recentes do Ctrl+P seguem o renomear/mover da árvore; se o destino já estava na lista, fica a posição mais recente.
export function moveRecentPaths(list: readonly string[], from: string, to: string): string[] {
  const moved = list.map((path) => movedPath(path, from, to))
  return moved.filter((path, i) => moved.indexOf(path) === i)
}

export interface ClosedFileTab {
  tab: FileTab
  index: number
}

const CLOSED_MAX = 20

// O que o Ctrl+Shift+T reabre. Num fechamento em lote a aba mais à esquerda fica no topo: reabrindo uma por uma,
// cada uma volta para a posição que tinha e a ordem original se refaz.
export function rememberClosed<T extends Listed>(history: readonly ClosedFileTab[], list: readonly T[], ids: readonly string[]): ClosedFileTab[] {
  const gone = new Set(ids)
  const closed = list.flatMap((t, index) => (t.kind === 'file' && gone.has(t.id) ? [{ tab: t as unknown as FileTab, index }] : []))
  return [...history, ...closed.reverse()].slice(-CLOSED_MAX)
}

const sameTarget = (a: FileTab, b: FileTab): boolean =>
  a.path === b.path && Boolean(a.diff) === Boolean(b.diff) && sameDiff(a.diff, b.diff) && a.compare?.left === b.compare?.left

// Volta como estava (visualizador, modo do Markdown), já fixa e sem a edição que não foi salva. Se o mesmo
// arquivo foi aberto de novo nesse meio-tempo, só vai até ele.
export function reopenClosed<T extends Listed>(
  list: readonly T[],
  history: readonly ClosedFileTab[]
): { list: (T | FileTab)[]; id: string; history: ClosedFileTab[] } | null {
  const last = history.at(-1)
  if (!last) return null
  const rest = history.slice(0, -1)
  const open = list.find((t) => t.kind === 'file' && sameTarget(t as unknown as FileTab, last.tab))
  if (open) return { list: [...list], id: open.id, history: rest }
  const restored: FileTab = { ...last.tab, id: uniqueId(list, last.tab.id), dirty: false, preview: false }
  delete restored.jump
  delete restored.focusRequest
  delete restored.deleted
  const at = Math.min(last.index, list.length)
  return { list: [...list.slice(0, at), restored, ...list.slice(at)], id: restored.id, history: rest }
}

// Ctrl+PageDown/PageUp: a próxima (ou anterior) aba de arquivo na barra, dando a volta. Terminais ficam de fora:
// com o foco no terminal o atalho é do processo, e o ciclo pararia nele.
export function siblingFileTab(list: readonly Listed[], activeId: string | undefined, step: 1 | -1): string | null {
  const n = list.length
  const at = list.findIndex((t) => t.id === activeId)
  const start = at >= 0 ? at : step === 1 ? -1 : n
  for (let i = 1; i <= n; i++) {
    const tab = list[(((start + i * step) % n) + n) % n]!
    if (tab.kind === 'file' && tab.id !== activeId) return tab.id
  }
  return null
}

const normalize = (rel: string): string => rel.replace(/\//g, '\\').toLowerCase()

// Pasta apagada chega do watcher como o nome da pasta, não como cada arquivo de dentro.
export function changeMayRemove(change: FilesChange, path: string): boolean {
  if (change.allFiles || change.rescan) return true
  const target = normalize(path)
  return change.files.some((f) => {
    const entry = normalize(f)
    return entry !== '' && (target === entry || target.startsWith(`${entry}\\`))
  })
}
