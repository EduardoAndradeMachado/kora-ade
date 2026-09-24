import koffi from 'koffi'

// Este arquivo também roda direto no Node (type stripping) no teste do processo dono:
// só sintaxe TypeScript apagável e nenhum import além do koffi.

const JobObjectExtendedLimitInformation = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100

const kernel32 = koffi.load('kernel32.dll')

// Structs anônimas: o nome registrado no koffi é global e colidiria se o módulo fosse carregado duas vezes.
// O koffi aplica o alinhamento natural do x64: 4 bytes de padding depois de LimitFlags e de
// ActiveProcessLimit, totalizando 64 bytes na parte básica e 144 na estendida.
const JOBOBJECT_BASIC_LIMIT_INFORMATION = koffi.struct({
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'size_t',
  MaximumWorkingSetSize: 'size_t',
  ActiveProcessLimit: 'uint32',
  Affinity: 'uintptr_t',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32'
})
const IO_COUNTERS = koffi.struct({
  ReadOperationCount: 'uint64',
  WriteOperationCount: 'uint64',
  OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64',
  WriteTransferCount: 'uint64',
  OtherTransferCount: 'uint64'
})
export const JOBOBJECT_EXTENDED_LIMIT_INFORMATION = koffi.struct({
  BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
  IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: 'size_t',
  JobMemoryLimit: 'size_t',
  PeakProcessMemoryUsed: 'size_t',
  PeakJobMemoryUsed: 'size_t'
})

const CreateJobObjectW = kernel32.func('__stdcall', 'CreateJobObjectW', 'void*', ['void*', 'void*'])
const SetInformationJobObject = kernel32.func('__stdcall', 'SetInformationJobObject', 'bool', [
  'void*',
  'int',
  koffi.pointer(JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
  'uint32'
])
const OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32, bool, uint32)')
const AssignProcessToJobObject = kernel32.func('bool __stdcall AssignProcessToJobObject(void*, void*)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void*)')

const isInvalidHandle = (h: unknown): boolean => !h || koffi.address(h) === 0xffffffffffffffffn

function zeroedLimits(): Record<string, unknown> {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0
  }
}

// Enquanto o handle estiver aberto neste processo, os processos atribuídos (e os filhos que eles criarem
// depois da atribuição) vivem; quando o último handle fecha — close() ou morte do Kora por qualquer
// motivo — o Windows encerra todos eles.
export class KillOnCloseJob {
  private handle: unknown

  constructor() {
    // Atributos de segurança nulos deixam o handle não herdável; se os filhos herdassem o handle,
    // o job continuaria aberto depois da morte do Kora e nada seria encerrado.
    const handle = CreateJobObjectW(null, null)
    if (isInvalidHandle(handle)) {
      console.error('[kora] CreateJobObjectW falhou; processos das abas não serão encerrados se o Kora morrer')
      this.handle = null
      return
    }
    const size = koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
    if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, zeroedLimits(), size)) {
      console.error('[kora] SetInformationJobObject falhou; processos das abas não serão encerrados se o Kora morrer')
      CloseHandle(handle)
      this.handle = null
      return
    }
    this.handle = handle
  }

  // Falha (false) quando o processo já saiu, quando não há permissão, quando o job foi fechado ou quando
  // o processo já pertence a um job fora desta hierarquia (o Windows 8+ só aninha se o job novo estiver vazio
  // ou já na cadeia do processo).
  assign(pid: number): boolean {
    if (this.handle === null || !Number.isInteger(pid) || pid <= 0) return false
    const proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
    if (isInvalidHandle(proc)) return false
    try {
      return AssignProcessToJobObject(this.handle, proc) === true
    } finally {
      CloseHandle(proc)
    }
  }

  // Encerra tudo que está no job.
  close(): void {
    if (this.handle === null) return
    CloseHandle(this.handle)
    this.handle = null
  }
}
