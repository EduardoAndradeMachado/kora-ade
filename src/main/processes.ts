import koffi from 'koffi'

export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  createdMs: number | null
}

const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const FILETIME_UNIX_EPOCH_MS = 11644473600000n

const kernel32 = koffi.load('kernel32.dll')

const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16_t', 260, 'String')
})
koffi.struct('FILETIME', { low: 'uint32', high: 'uint32' })

const CreateToolhelp32Snapshot = kernel32.func('void* __stdcall CreateToolhelp32Snapshot(uint32, uint32)')
const Process32FirstW = kernel32.func('bool __stdcall Process32FirstW(void*, _Inout_ PROCESSENTRY32W*)')
const Process32NextW = kernel32.func('bool __stdcall Process32NextW(void*, _Inout_ PROCESSENTRY32W*)')
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32, bool, uint32)')
const GetProcessTimes = kernel32.func(
  'bool __stdcall GetProcessTimes(void*, _Out_ FILETIME*, _Out_ FILETIME*, _Out_ FILETIME*, _Out_ FILETIME*)'
)
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)')

const isInvalidHandle = (h: unknown): boolean => !h || koffi.address(h) === 0xffffffffffffffffn

function creationTimeMs(pid: number): number | null {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (isInvalidHandle(handle)) return null
  try {
    const created = { low: 0, high: 0 }
    if (!GetProcessTimes(handle, created, {}, {}, {})) return null
    const ticks = (BigInt(created.high) << 32n) | BigInt(created.low)
    return Number(ticks / 10000n - FILETIME_UNIX_EPOCH_MS)
  } finally {
    CloseHandle(handle)
  }
}

export function listProcesses(): ProcInfo[] {
  const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (isInvalidHandle(snapshot)) return []
  const list: ProcInfo[] = []
  try {
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) }
    let ok = Process32FirstW(snapshot, entry)
    while (ok) {
      const e = entry as unknown as { th32ProcessID: number; th32ParentProcessID: number; szExeFile: string }
      list.push({ pid: e.th32ProcessID, ppid: e.th32ParentProcessID, name: e.szExeFile, createdMs: null })
      ok = Process32NextW(snapshot, entry)
    }
  } finally {
    CloseHandle(snapshot)
  }
  return list
}

export function descendants(rootPid: number, all: ProcInfo[]): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>()
  for (const p of all) {
    if (p.pid === p.ppid) continue
    const siblings = byParent.get(p.ppid)
    if (siblings) siblings.push(p)
    else byParent.set(p.ppid, [p])
  }
  const found: ProcInfo[] = []
  const stack = [rootPid]
  const seen = new Set<number>([rootPid])
  while (stack.length) {
    for (const child of byParent.get(stack.pop()!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      stack.push(child.pid)
    }
  }
  return found
}

const rstrtmgr = koffi.load('rstrtmgr.dll')
const RM_UNIQUE_PROCESS = koffi.struct('RM_UNIQUE_PROCESS', { dwProcessId: 'uint32', ProcessStartTime: 'FILETIME' })
const RM_PROCESS_INFO = koffi.struct('RM_PROCESS_INFO', {
  Process: RM_UNIQUE_PROCESS,
  strAppName: koffi.array('char16_t', 256, 'String'),
  strServiceShortName: koffi.array('char16_t', 64, 'String'),
  ApplicationType: 'int32',
  AppStatus: 'uint32',
  TSSessionId: 'uint32',
  bRestartable: 'int32'
})
const RmStartSession = rstrtmgr.func('uint32 __stdcall RmStartSession(_Out_ uint32*, uint32, _Out_ char16_t*)')
const RmRegisterResources = rstrtmgr.func(
  'uint32 __stdcall RmRegisterResources(uint32, uint32, const char16_t**, uint32, void*, uint32, void*)'
)
const RmGetList = rstrtmgr.func(
  'uint32 __stdcall RmGetList(uint32, _Out_ uint32*, _Inout_ uint32*, _Out_ RM_PROCESS_INFO*, _Out_ uint32*)'
)
const RmEndSession = rstrtmgr.func('uint32 __stdcall RmEndSession(uint32)')
const ERROR_MORE_DATA = 234

// Pergunta ao Windows (Restart Manager) quais processos estão com o arquivo aberto.
export function fileHolders(file: string): number[] {
  const handle = [0]
  const key = Buffer.alloc(66)
  if (RmStartSession(handle, 0, key) !== 0) return []
  const session = handle[0]!
  try {
    if (RmRegisterResources(session, 1, [file], 0, null, 0, null) !== 0) return []
    let capacity = 4
    for (let attempt = 0; attempt < 3; attempt++) {
      const needed = [0]
      const count = [capacity]
      const infos = koffi.alloc(RM_PROCESS_INFO, capacity)
      const status = RmGetList(session, needed, count, infos, [0])
      if (status === ERROR_MORE_DATA) {
        capacity = needed[0]! + 2
        continue
      }
      if (status !== 0) return []
      const decoded = koffi.decode(infos, RM_PROCESS_INFO, count[0]!) as { Process: { dwProcessId: number } }[]
      return decoded.map((i) => i.Process.dwProcessId)
    }
    return []
  } finally {
    RmEndSession(session)
  }
}

export function withCreationTime(p: ProcInfo): ProcInfo {
  return { ...p, createdMs: creationTimeMs(p.pid) }
}
