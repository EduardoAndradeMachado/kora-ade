import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { emptyState, parseState, StateSchema, type KoraState } from '../shared/state'
import { isBlocked, readTextRetrying, renameRetrying, replaceDurable, writeDurable } from './durable-file'

// Uma foto por hora em que algo mudou: o .bak só guarda a gravação anterior, e abas salvam o tempo todo.
const SNAPSHOTS_KEPT = 48

const tmpFile = (file: string): string => `${file}.tmp`
const restoreFile = (file: string): string => `${file}.restore`
export const backupFile = (file: string): string => `${file}.bak`
export const snapshotDir = (file: string): string => `${file}.snapshots`

// source null: nenhuma cópia válida sobrou e o app abriu vazio. readOnly: algum arquivo está preso e nada será gravado
// até reabrir.
export interface StateRecovery {
  source: string | null
  savedAt: Date | null
  corrupt: string | null
  snapshots: string
  readOnly: boolean
}

export interface LoadedState {
  state: KoraState
  recovery: StateRecovery | null
}

interface Copy {
  path: string
  state: KoraState
  generation: number
  savedAt: Date
}

// A geração sobe a cada gravação e decide qual cópia é a mais nova: data de arquivo engana quando o relógio do PC muda.
const saved = new Map<string, { generation: number; empty: boolean }>()
const readOnly = new Set<string>()
// Cópia recuperada que não conseguiu virar principal: a próxima gravação não pode reabri-la para escrita.
const pinned = new Map<string, string>()

const isEmpty = (state: KoraState): boolean => state.projects.length === 0 && state.groups.length === 0

export const isReadOnly = (file: string): boolean => readOnly.has(file)

function readCopy(path: string): Copy {
  const raw = JSON.parse(readTextRetrying(path)) as { generation?: unknown } | null
  const generation = Number.isSafeInteger(raw?.generation) ? (raw?.generation as number) : 0
  return { path, state: parseState(raw), generation, savedAt: statSync(path).mtime }
}

function serialize(state: KoraState, generation: number): string {
  // derivedName é o nome do processo do Claude que está rodando; gravado, voltaria como endereço de um processo morto.
  return JSON.stringify({ ...state, generation }, (key, value: unknown) => (key === 'derivedName' ? undefined : value), 2)
}

function snapshotsNewestFirst(file: string): string[] {
  try {
    return readdirSync(snapshotDir(file)).filter((name) => name.endsWith('.json')).sort().reverse()
  } catch {
    return []
  }
}

function newestSnapshotGeneration(file: string): number {
  return Number.parseInt(snapshotsNewestFirst(file)[0] ?? '0', 10) || 0
}

// Versão anterior regrava sem geração. Sem isto, voltar para esta versão recomeçaria a contar abaixo das cópias antigas,
// e numa recuperação uma delas venceria a lista atual.
function newestKnownGeneration(file: string): number {
  let backup = 0
  try {
    backup = readCopy(backupFile(file)).generation
  } catch {
    // Sem .bak legível, valem as fotos.
  }
  return Math.max(backup, newestSnapshotGeneration(file))
}

function setAside(file: string, reason: unknown): string | null {
  const corrupt = `${file}.corrupt-${Date.now()}`
  try {
    // Arquivo ilegível não pode ser sobrescrito pelo próximo save: é a lista de projetos do usuário.
    renameRetrying(file, corrupt)
    console.error(`[kora] estado inválido em ${file}; preservado em ${corrupt}`, reason)
    return corrupt
  } catch (err) {
    console.error(`[kora] estado inválido em ${file}; não foi possível tirá-lo do lugar`, reason, err)
    return null
  }
}

function publish(file: string, copy: Copy): void {
  try {
    // Gravação completa que só faltou renomear vira o principal sem ser reescrita: abri-la apagaria a cópia.
    if (copy.path === tmpFile(file) || copy.path === restoreFile(file)) {
      renameRetrying(copy.path, file)
      return
    }
    writeDurable(restoreFile(file), serialize(copy.state, copy.generation))
    renameRetrying(restoreFile(file), file)
  } catch (err) {
    pinned.set(file, copy.path)
    console.error('[kora] falha ao regravar o estado recuperado; a cópia continua no lugar', err)
  }
}

export function loadState(file: string): LoadedState {
  readOnly.delete(file)
  pinned.delete(file)
  const existed = existsSync(file)
  let corrupt: string | null = null
  let blocked = false
  if (existed) {
    try {
      const main = readCopy(file)
      const generation = main.generation || newestKnownGeneration(file)
      saved.set(file, { generation, empty: isEmpty(main.state) })
      if (generation !== main.generation) publish(file, { ...main, generation })
      return { state: main.state, recovery: null }
    } catch (err) {
      if (isBlocked(err)) {
        console.error(`[kora] estado preso em ${file}; nada será gravado até reabrir`, err)
        blocked = true
      } else {
        corrupt = setAside(file, err)
        blocked = corrupt === null
      }
    }
  }
  const dir = snapshotDir(file)
  const candidates = [tmpFile(file), restoreFile(file), backupFile(file), ...snapshotsNewestFirst(file).map((name) => join(dir, name))]
    .filter((path) => existsSync(path))
  const copies: Copy[] = []
  for (const path of candidates) {
    try {
      copies.push(readCopy(path))
    } catch (err) {
      // Foto ruim é só uma reserva a menos; .tmp e .bak presos podem ter a lista mais nova.
      blocked ||= isBlocked(err) && !path.startsWith(dir)
      console.error(`[kora] cópia de estado inválida em ${path}`, err)
      // A próxima gravação ocuparia o lugar do .bak, e erro de disco pode ser passageiro: ele sai do caminho inteiro.
      if (!blocked && path === backupFile(file)) setAside(path, err)
    }
  }
  if (blocked) readOnly.add(file)
  // Empate entre arquivos sem geração cai na ordem de candidates: sort é estável.
  const best = copies.sort((a, b) => b.generation - a.generation)[0]
  saved.set(file, { generation: Math.max(best?.generation ?? 0, newestSnapshotGeneration(file)), empty: best ? isEmpty(best.state) : true })
  if (best) {
    const { path, state, generation, savedAt } = best
    console.error(`[kora] estado recuperado de ${path} (geração ${generation}): ${state.projects.length} projetos, ${state.groups.length} categorias, ${state.tabs.length} abas`)
    if (!blocked) publish(file, best)
    return { state, recovery: { source: path, savedAt, corrupt, snapshots: dir, readOnly: blocked } }
  }
  if (!existed && candidates.length === 0) return { state: emptyState(), recovery: null }
  console.error(`[kora] nenhuma cópia válida do estado; abrindo vazio (${candidates.length} tentadas)`)
  return { state: emptyState(), recovery: { source: null, savedAt: null, corrupt, snapshots: dir, readOnly: blocked } }
}

export function recoveryMessage(recovery: StateRecovery): string {
  if (recovery.readOnly) {
    return 'Outro programa está segurando a lista de projetos. O que você mudar agora não será gravado: saia pelo ícone da bandeja e abra o Kora de novo.'
  }
  if (recovery.source === null) {
    const kept = recovery.corrupt ? ` O arquivo danificado ficou em ${recovery.corrupt}.` : ''
    return `Não foi possível ler a lista de projetos nem as cópias dela.${kept} Cópias antigas ficam em ${recovery.snapshots}.`
  }
  return `A gravação da lista de projetos foi interrompida. O Kora voltou para a cópia de ${recovery.savedAt?.toLocaleString('pt-BR')}.`
}

function takeSnapshot(file: string, state: KoraState, text: string, generation: number): void {
  if (isEmpty(state)) return
  try {
    const dir = snapshotDir(file)
    const names = snapshotsNewestFirst(file)
    const hour = new Date().toISOString().slice(0, 13)
    if (names[0]?.endsWith(`-${hour}.json`)) return
    mkdirSync(dir, { recursive: true })
    replaceDurable(join(dir, `${String(generation).padStart(12, '0')}-${hour}.json`), text)
    for (const old of names.slice(SNAPSHOTS_KEPT - 1)) rmSync(join(dir, old), { force: true })
  } catch (err) {
    // A foto é reserva: falhar nela não pode impedir a gravação que acabou de dar certo.
    console.error('[kora] falha ao guardar foto do estado', err)
  }
}

function rotateBackup(file: string): void {
  // Principal vazio não ocupa o lugar da última lista boa: é assim que o app fica depois de não achar cópia legível.
  if (!existsSync(file) || saved.get(file)?.empty) return
  try {
    // Mover não reescreve nada: a versão anterior chega ao .bak com os bytes que já passaram pelo fsync.
    renameRetrying(file, backupFile(file))
  } catch (err) {
    console.error('[kora] falha ao guardar a versão anterior do estado', err)
  }
}

export function saveState(file: string, state: KoraState): void {
  if (readOnly.has(file)) return
  const valid = StateSchema.parse(state)
  const generation = (saved.get(file)?.generation ?? 0) + 1
  const text = serialize(valid, generation)
  const tmp = pinned.get(file) === tmpFile(file) ? restoreFile(file) : tmpFile(file)
  writeDurable(tmp, text)
  rotateBackup(file)
  renameRetrying(tmp, file)
  pinned.delete(file)
  saved.set(file, { generation, empty: isEmpty(valid) })
  takeSnapshot(file, valid, text, generation)
}
