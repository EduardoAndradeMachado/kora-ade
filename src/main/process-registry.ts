import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import koffi from 'koffi'
import { z } from 'zod'
import { AgentKindSchema } from '../shared/agent'
import { listProcesses, withCreationTime, type ProcInfo } from './processes'

const ProcessIdentitySchema = z.object({ pid: z.number().int().positive(), createdMs: z.number() })
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>

const RegisteredProcessSchema = z.object({
  pid: z.number().int().positive(),
  createdMs: z.number(),
  tabId: z.string(),
  projectId: z.string(),
  title: z.string(),
  agentKind: AgentKindSchema.nullable(),
  launchedAt: z.number(),
  // Qual processo do Kora lançou: só é órfão o que foi lançado por um Kora que já morreu.
  owner: ProcessIdentitySchema
})
export type RegisteredProcess = z.infer<typeof RegisteredProcessSchema>
export type LaunchInfo = Pick<RegisteredProcess, 'pid' | 'tabId' | 'projectId' | 'title' | 'agentKind'>

const RegistryFileSchema = z.object({ version: z.literal(1), processes: z.array(RegisteredProcessSchema) })

export interface TreeProcess {
  pid: number
  ppid: number
  name: string
  createdMs: number
  depth: number
}

export interface Survivor {
  key: string
  entry: RegisteredProcess
  // Raiz primeiro (se ainda viva), depois os descendentes.
  processes: TreeProcess[]
  // Soma de PrivateUsage (memória confirmada exclusiva do processo) da árvore inteira.
  memoryBytes: number
}

export interface KillResult {
  killed: number
  // Já tinham saído (ou o PID agora é de outro programa) quando chegou a vez deles.
  gone: number
  failed: number
}

const PROCESS_TERMINATE = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x00100000
const FILETIME_UNIX_EPOCH_MS = 11644473600000n
const KILL_WAIT_MS = 2000

const kernel32 = koffi.load('kernel32.dll')
const FILETIME = koffi.struct({ low: 'uint32', high: 'uint32' })
const PROCESS_MEMORY_COUNTERS_EX = koffi.struct({
  cb: 'uint32',
  PageFaultCount: 'uint32',
  PeakWorkingSetSize: 'size_t',
  WorkingSetSize: 'size_t',
  QuotaPeakPagedPoolUsage: 'size_t',
  QuotaPagedPoolUsage: 'size_t',
  QuotaPeakNonPagedPoolUsage: 'size_t',
  QuotaNonPagedPoolUsage: 'size_t',
  PagefileUsage: 'size_t',
  PeakPagefileUsage: 'size_t',
  PrivateUsage: 'size_t'
})
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32, bool, uint32)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)')
const GetProcessTimes = kernel32.func('__stdcall', 'GetProcessTimes', 'bool', [
  'void*',
  koffi.out(koffi.pointer(FILETIME)),
  koffi.out(koffi.pointer(FILETIME)),
  koffi.out(koffi.pointer(FILETIME)),
  koffi.out(koffi.pointer(FILETIME))
])
const K32GetProcessMemoryInfo = kernel32.func('__stdcall', 'K32GetProcessMemoryInfo', 'bool', [
  'void*',
  koffi.out(koffi.pointer(PROCESS_MEMORY_COUNTERS_EX)),
  'uint32'
])
const TerminateProcess = kernel32.func('bool __stdcall TerminateProcess(void*, uint32)')
const WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(void*, uint32)')
const WAIT_OBJECT_0 = 0

const isInvalidHandle = (h: unknown): boolean => !h || koffi.address(h) === 0xffffffffffffffffn

function handleCreatedMs(handle: unknown): number | null {
  const created = { low: 0, high: 0 }
  if (!GetProcessTimes(handle, created, {}, {}, {})) return null
  const ticks = (BigInt(created.high) << 32n) | BigInt(created.low)
  return Number(ticks / 10000n - FILETIME_UNIX_EPOCH_MS)
}

// A identidade é conferida no mesmo handle usado para ler ou encerrar: entre listar e agir o PID pode
// ter sido reaproveitado, e o handle aberto fixa o processo.
function withVerifiedHandle<T>(p: ProcessIdentity, access: number, use: (handle: unknown) => T): T | null {
  const handle = OpenProcess(access, false, p.pid)
  if (isInvalidHandle(handle)) return null
  try {
    return handleCreatedMs(handle) === p.createdMs ? use(handle) : null
  } finally {
    CloseHandle(handle)
  }
}

function privateBytes(p: ProcessIdentity): number {
  return (
    withVerifiedHandle(p, PROCESS_QUERY_LIMITED_INFORMATION, (handle) => {
      const counters: Record<string, number> = {}
      const size = koffi.sizeof(PROCESS_MEMORY_COUNTERS_EX)
      if (!K32GetProcessMemoryInfo(handle, counters, size)) return 0
      return Number(counters['PrivateUsage'] ?? 0)
    }) ?? 0
  )
}

function terminate(p: ProcessIdentity): keyof KillResult {
  const outcome = withVerifiedHandle(p, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, (handle) => {
    if (!TerminateProcess(handle, 1)) return 'failed'
    return WaitForSingleObject(handle, KILL_WAIT_MS) === WAIT_OBJECT_0 ? 'killed' : 'failed'
  })
  return outcome ?? 'gone'
}

function snapshot(): ProcInfo[] {
  return listProcesses().map(withCreationTime)
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.createdMs === b.createdMs
}

function isRunning(p: ProcessIdentity, all: ProcInfo[]): boolean {
  return all.some((q) => q.pid === p.pid && q.createdMs === p.createdMs)
}

// O Windows não atualiza o ppid quando o pai morre, e o PID do pai pode ter sido reaproveitado.
// Um processo só é filho de `node` se nasceu depois dele e antes de qualquer processo que hoje ocupe o PID dele.
export function survivorTree(root: ProcessIdentity, all: ProcInfo[]): TreeProcess[] {
  const byPid = new Map<number, ProcInfo>()
  const byParent = new Map<number, ProcInfo[]>()
  for (const p of all) {
    byPid.set(p.pid, p)
    if (p.pid === p.ppid) continue
    const siblings = byParent.get(p.ppid)
    if (siblings) siblings.push(p)
    else byParent.set(p.ppid, [p])
  }

  const tree: TreeProcess[] = []
  const rootNow = byPid.get(root.pid)
  if (rootNow && rootNow.createdMs === root.createdMs) {
    tree.push({ pid: root.pid, ppid: rootNow.ppid, name: rootNow.name, createdMs: root.createdMs, depth: 0 })
  }

  const seen = new Set<string>([`${root.pid}:${root.createdMs}`])
  const queue: { node: ProcessIdentity; depth: number }[] = [{ node: root, depth: 0 }]
  while (queue.length) {
    const { node, depth } = queue.shift()!
    const holder = byPid.get(node.pid)
    const upper = holder && holder.createdMs !== node.createdMs ? (holder.createdMs ?? -Infinity) : Infinity
    for (const child of byParent.get(node.pid) ?? []) {
      if (child.createdMs === null || child.createdMs < node.createdMs || child.createdMs >= upper) continue
      const key = `${child.pid}:${child.createdMs}`
      if (seen.has(key)) continue
      seen.add(key)
      const identity = { pid: child.pid, createdMs: child.createdMs }
      tree.push({ ...identity, ppid: child.ppid, name: child.name, depth: depth + 1 })
      queue.push({ node: identity, depth: depth + 1 })
    }
  }
  return tree
}

// Filhos antes do pai: se o shell morresse primeiro, o agente dentro dele ainda poderia criar processos
// novos entre uma chamada e outra.
export function killOrder(processes: TreeProcess[]): TreeProcess[] {
  return [...processes].sort((a, b) => b.depth - a.depth)
}

export function currentProcessIdentity(): ProcessIdentity {
  const createdMs = withCreationTime({ pid: process.pid, ppid: 0, name: '', createdMs: null }).createdMs
  if (createdMs === null) throw new Error('não foi possível ler o horário de criação do próprio processo')
  return { pid: process.pid, createdMs }
}

// Registro em disco dos processos que o Kora lançou, para descobrir na próxima abertura o que sobrou
// de uma execução que morreu sem encerrar as abas.
export class ProcessRegistry {
  private entries: RegisteredProcess[]

  constructor(
    private readonly file: string,
    private readonly owner: ProcessIdentity = currentProcessIdentity()
  ) {
    this.entries = this.load()
  }

  private load(): RegisteredProcess[] {
    if (!existsSync(this.file)) return []
    try {
      return RegistryFileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))).processes
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        renameSync(this.file, backup)
      } catch {
        // Se nem o backup der certo, segue vazio: o registro é auxiliar e não pode impedir o app de abrir.
      }
      console.error(`[kora] registro de processos inválido em ${this.file}; preservado em ${backup}`, err)
      return []
    }
  }

  private save(): void {
    try {
      const data = RegistryFileSchema.parse({ version: 1, processes: this.entries })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      // Chamado do spawn e do onExit das abas: falha de disco aqui não pode derrubar o terminal.
      console.error(`[kora] não foi possível gravar o registro de processos em ${this.file}`, err)
    }
  }

  list(): RegisteredProcess[] {
    return [...this.entries]
  }

  // Registrar de novo o mesmo PID atualiza título e agente, mantendo a identidade original.
  add(launch: LaunchInfo): boolean {
    const existing = this.entries.find((e) => e.pid === launch.pid && sameIdentity(e.owner, this.owner))
    if (existing) {
      existing.title = launch.title
      existing.agentKind = launch.agentKind
      existing.tabId = launch.tabId
      existing.projectId = launch.projectId
      this.save()
      return true
    }
    const createdMs = withCreationTime({ pid: launch.pid, ppid: 0, name: '', createdMs: null }).createdMs
    if (createdMs === null) return false
    this.entries.push({ ...launch, createdMs, launchedAt: Date.now(), owner: this.owner })
    this.save()
    return true
  }

  remove(pid: number): void {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => !(e.pid === pid && sameIdentity(e.owner, this.owner)))
    if (this.entries.length !== before) this.save()
  }

  // Sobreviventes são processos de um Kora que já morreu e que continuam vivos com o mesmo horário de
  // criação (ou descendentes deles). Entradas desses Koras mortos sem nada vivo são descartadas.
  findSurvivors(): Survivor[] {
    const all = snapshot()
    const survivors: Survivor[] = []
    const kept: RegisteredProcess[] = []
    for (const entry of this.entries) {
      if (isRunning(entry.owner, all)) {
        kept.push(entry)
        continue
      }
      const processes = survivorTree(entry, all)
      if (processes.length === 0) continue
      kept.push(entry)
      survivors.push({
        key: `${entry.pid}:${entry.createdMs}`,
        entry,
        processes,
        memoryBytes: processes.reduce((sum, p) => sum + privateBytes(p), 0)
      })
    }
    if (kept.length !== this.entries.length) {
      this.entries = kept
      this.save()
    }
    return survivors
  }

  // Encerra a árvore atual do sobrevivente, filhos antes do pai. A árvore é recalculada porque o
  // processo pode ter criado outros filhos desde findSurvivors().
  killTree(survivor: Survivor): KillResult {
    const fresh = survivorTree(survivor.entry, snapshot())
    const byKey = new Map<string, TreeProcess>()
    for (const p of [...survivor.processes, ...fresh]) byKey.set(`${p.pid}:${p.createdMs}`, p)
    const result: KillResult = { killed: 0, gone: 0, failed: 0 }
    for (const p of killOrder([...byKey.values()])) result[terminate(p)]++
    if (result.failed === 0) this.forget(survivor)
    return result
  }

  // O usuário escolheu manter: o Kora deixa de acompanhar esses processos.
  forget(survivor: Survivor): void {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => !sameIdentity(e, survivor.entry))
    if (this.entries.length !== before) this.save()
  }
}
