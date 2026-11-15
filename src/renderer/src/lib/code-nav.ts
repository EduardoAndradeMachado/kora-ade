import { monaco } from '@/lib/monaco'
import { isNotFound } from '@/lib/ipc-error'
import type { FilesChange } from '@shared/ipc'
import {
  MAX_NAV_BYTES,
  MAX_NAV_FILE_BYTES,
  isNavFile,
  isTsconfig,
  mergePaths,
  navCandidates,
  navCompilerOptions,
  pathsFromTsconfig,
  projectUriPath,
  relFromUriPath
} from '@/lib/code-nav-core'

// Navegação entre arquivos (F12, Ctrl+clique, Shift+F12): o worker do TypeScript recebe o texto do disco dos arquivos
// do projeto como "extra libs". O arquivo aberto numa aba é um model com a mesma URI e vale mais que a cópia do disco.

const READ_CONCURRENCY = 8
const CHANGE_DEBOUNCE_MS = 400
// Fechar a última aba de código e abrir outra logo em seguida não deve reler o projeto todo.
const UNLOAD_DELAY_MS = 30_000

interface Lib {
  rel: string
  content: string
}

interface ProjectNav {
  users: number
  libs: Map<string, Lib>
  paths: Record<string, string[]>
  near: string
  pending: Set<string>
  reloadAll: boolean
  flushTimer?: ReturnType<typeof setTimeout>
  unloadTimer?: ReturnType<typeof setTimeout>
  unsubscribe(): void
}

const projects = new Map<string, ProjectNav>()
// URIs dos models que pertencem a uma aba. Os outros models de arquivo do projeto foram criados pelo Monaco para
// mostrar uma definição ou referência (peek) e podem ceder a URI para a aba.
const owned = new Set<string>()

const uriOf = (projectId: string, rel: string): monaco.Uri => monaco.Uri.file(projectUriPath(projectId, rel))
const bytesOf = (libs: Map<string, Lib>): number => {
  let total = 0
  for (const lib of libs.values()) total += lib.content.length
  return total
}

const defaults = [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]
let appliedPaths = '{}'
let applyTimer: ReturnType<typeof setTimeout> | undefined

const setCompilerOptions = (paths: Record<string, string[]>): void => {
  for (const d of defaults) d.setCompilerOptions(navCompilerOptions(paths) as monaco.typescript.CompilerOptions)
}
setCompilerOptions({})

// Uma lib por vez em vez de setExtraLibs: o setExtraLibs dá versão nova a todas e o worker reprocessaria o projeto
// inteiro a cada arquivo salvo; addExtraLib com o mesmo texto não muda nada e com texto novo muda só aquela.
const applied = new Map<string, { content: string; handles: monaco.IDisposable[] }>()

// Mudar compilerOptions reinicia os workers; só acontece quando um projeto com "paths" entra ou sai.
function applySoon(): void {
  clearTimeout(applyTimer)
  applyTimer = setTimeout(() => {
    const wanted = new Map<string, string>()
    for (const p of projects.values()) for (const [filePath, lib] of p.libs) wanted.set(filePath, lib.content)
    for (const [filePath, lib] of applied) {
      if (wanted.has(filePath)) continue
      for (const handle of lib.handles) handle.dispose()
      applied.delete(filePath)
    }
    for (const [filePath, content] of wanted) {
      if (applied.get(filePath)?.content === content) continue
      applied.set(filePath, { content, handles: defaults.map((d) => d.addExtraLib(content, filePath)) })
    }
    const paths = mergePaths([...projects.values()].map((p) => p.paths))
    const pathsKey = JSON.stringify(paths)
    if (pathsKey !== appliedPaths) {
      appliedPaths = pathsKey
      setCompilerOptions(paths)
    }
  }, 50)
}

async function readAll(projectId: string, rels: string[], budget: number, into: Map<string, Lib>): Promise<void> {
  let next = 0
  let used = 0
  const worker = async (): Promise<void> => {
    for (let rel = rels[next++]; rel !== undefined && used < budget; rel = rels[next++]) {
      try {
        const file = await window.kora.readText(projectId, rel)
        if (file.content.length > MAX_NAV_FILE_BYTES || used + file.content.length > budget) continue
        used += file.content.length
        into.set(uriOf(projectId, rel).toString(), { rel, content: file.content.replace(/^﻿/, '') })
      } catch {
        // Binário, grande demais ou apagado entre a listagem e a leitura: só fica fora da navegação.
      }
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
}

async function load(projectId: string, p: ProjectNav): Promise<void> {
  let files: string[]
  try {
    files = await window.kora.listProjectFiles(projectId)
  } catch (err) {
    console.warn('Navegação entre arquivos sem a lista do projeto:', err)
    return
  }
  const configs = files.filter(isTsconfig).slice(0, 20)
  const pathsList = await Promise.all(
    configs.map((rel) =>
      window.kora.readText(projectId, rel).then(
        (file) => pathsFromTsconfig(rel, file.content.replace(/^﻿/, ''), (r) => uriOf(projectId, r).toString()),
        () => ({})
      )
    )
  )
  const libs = new Map<string, Lib>()
  await readAll(projectId, navCandidates(files, p.near), MAX_NAV_BYTES, libs)
  if (projects.get(projectId) !== p) return
  p.paths = mergePaths(pathsList)
  p.libs = libs
  applySoon()
}

async function flush(projectId: string, p: ProjectNav): Promise<void> {
  if (p.reloadAll) {
    p.reloadAll = false
    p.pending.clear()
    return load(projectId, p)
  }
  const rels = [...p.pending]
  p.pending.clear()
  await Promise.all(
    rels.map(async (rel) => {
      const key = uriOf(projectId, rel).toString()
      try {
        const file = await window.kora.readText(projectId, rel)
        const room = MAX_NAV_BYTES - bytesOf(p.libs) + (p.libs.get(key)?.content.length ?? 0)
        if (file.content.length > MAX_NAV_FILE_BYTES || file.content.length > room) p.libs.delete(key)
        else p.libs.set(key, { rel, content: file.content.replace(/^﻿/, '') })
      } catch (err) {
        if (isNotFound(err)) p.libs.delete(key)
      }
    })
  )
  if (projects.get(projectId) === p) applySoon()
}

// Pasta renomeada ou movida chega como o nome da pasta, não como os arquivos de dentro: aí relê a lista toda. Sem
// listagem alterada (change.dirs vazio) um nome sem extensão é arquivo editado (Makefile), não pasta.
function onChange(projectId: string, p: ProjectNav, change: FilesChange): void {
  if (change.rescan || change.allFiles) p.reloadAll = true
  const holdsLibs = (rel: string): boolean => {
    const prefix = rel.toLowerCase() + '\\'
    for (const lib of p.libs.values()) if (lib.rel.toLowerCase().startsWith(prefix)) return true
    return false
  }
  for (const rel of change.files) {
    if (isTsconfig(rel)) p.reloadAll = true
    else if (isNavFile(rel)) p.pending.add(rel)
    else if (change.dirs.length > 0 && (!/\.[^\\/]+$/.test(rel) || holdsLibs(rel))) p.reloadAll = true
  }
  if (!p.reloadAll && p.pending.size === 0) return
  clearTimeout(p.flushTimer)
  p.flushTimer = setTimeout(() => void flush(projectId, p), CHANGE_DEBOUNCE_MS)
}

function unload(projectId: string): void {
  const p = projects.get(projectId)
  if (!p || p.users > 0) return
  projects.delete(projectId)
  p.unsubscribe()
  clearTimeout(p.flushTimer)
  for (const model of monaco.editor.getModels()) {
    const uri = model.uri.toString()
    if (model.uri.path.startsWith(`/${projectId}/`) && !owned.has(uri) && !model.isAttachedToEditor()) model.dispose()
  }
  applySoon()
}

// Chamado por cada aba de código TS/JS; o projeto é lido na primeira e solto um tempo depois da última fechar.
export function acquireProjectNavigation(projectId: string, near: string): () => void {
  let p = projects.get(projectId)
  if (!p) {
    const created: ProjectNav = { users: 0, libs: new Map(), paths: {}, near, pending: new Set(), reloadAll: false, unsubscribe: () => {} }
    created.unsubscribe = window.kora.onFilesChanged((changed, change) => {
      if (changed === projectId) onChange(projectId, created, change)
    })
    projects.set(projectId, created)
    p = created
    void load(projectId, created)
  }
  const current = p
  clearTimeout(current.unloadTimer)
  current.users++
  let released = false
  return () => {
    if (released) return
    released = true
    current.users--
    if (current.users === 0) current.unloadTimer = setTimeout(() => unload(projectId), UNLOAD_DELAY_MS)
  }
}

// --- models das abas ---------------------------------------------------------------------------------------------

let duplicateCounter = 0

export function claimModelUri(projectId: string, path: string): monaco.Uri {
  const base = uriOf(projectId, path)
  const existing = monaco.editor.getModel(base)
  if (existing && !owned.has(base.toString()) && !existing.isAttachedToEditor()) existing.dispose()
  // O Monaco recusa dois models com a mesma URI; o mesmo arquivo aberto duas vezes ganha uma query.
  const uri = monaco.editor.getModel(base) ? base.with({ query: `aba=${++duplicateCounter}` }) : base
  owned.add(uri.toString())
  return uri
}

export const releaseModelUri = (uri: monaco.Uri): void => void owned.delete(uri.toString())

// --- abrir o arquivo da definição numa aba do Kora ---------------------------------------------------------------

interface EditorHost {
  projectId: string
  open(rel: string, line: number): void
}

const hosts = new Map<monaco.editor.ICodeEditor, EditorHost>()
let lastFocused: EditorHost | null = null
let pendingColumn: { projectId: string; rel: string; line: number; column: number } | null = null

export function registerEditorHost(editor: monaco.editor.ICodeEditor, host: EditorHost): monaco.IDisposable {
  hosts.set(editor, host)
  const focus = editor.onDidFocusEditorText(() => (lastFocused = host))
  return {
    dispose: () => {
      focus.dispose()
      hosts.delete(editor)
      if (lastFocused === host) lastFocused = null
    }
  }
}

// O Monaco só abre sozinho o próprio model do editor; outro arquivo vira aba do Kora, que pula para a linha. A coluna
// fica guardada para a aba aplicar depois do salto (onOpenPath só leva a linha).
monaco.editor.registerEditorOpener({
  openCodeEditor(source, resource, selectionOrPosition) {
    if (resource.scheme !== 'file' || source.getModel()?.uri.toString() === resource.toString()) return false
    const projectId = resource.path.split('/')[1] ?? ''
    const rel = relFromUriPath(projectId, resource.path)
    // O editor embutido no peek não é de aba nenhuma: vale a última aba de código com foco.
    const host = [hosts.get(source), lastFocused].find((h) => h?.projectId === projectId)
    if (!rel || !host) return false
    const position = selectionOrPosition
      ? 'startLineNumber' in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
        : { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
      : { line: 1, column: 1 }
    pendingColumn = { projectId, rel: rel.toLowerCase(), ...position }
    host.open(rel, position.line)
    return true
  }
})

export function takeJumpColumn(projectId: string, rel: string, line: number): number | null {
  const pending = pendingColumn
  if (!pending || pending.projectId !== projectId || pending.rel !== rel.replace(/\//g, '\\').toLowerCase() || pending.line !== line) return null
  pendingColumn = null
  return pending.column
}
