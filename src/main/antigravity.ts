import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import koffi from 'koffi'
import type { AntigravitySource } from './usage'

const CRED_TYPE_GENERIC = 1
const CRED_PERSIST_LOCAL_MACHINE = 2
// Onde o agy guarda o login (go-keyring no Cofre de Credenciais do Windows): serviço "gemini", usuário "antigravity".
export const AGY_CREDENTIAL_TARGET = 'gemini:antigravity'
const AGY_CREDENTIAL_USER = 'antigravity'
const VERSION_TIMEOUT_MS = 5_000

// Struct anônima: o nome registrado no koffi é global e colidiria se o módulo fosse carregado duas vezes.
const CREDENTIALW = koffi.struct({
  Flags: 'uint32',
  Type: 'uint32',
  TargetName: 'str16',
  Comment: 'str16',
  LastWrittenLow: 'uint32',
  LastWrittenHigh: 'uint32',
  CredentialBlobSize: 'uint32',
  CredentialBlob: 'void *',
  Persist: 'uint32',
  AttributeCount: 'uint32',
  Attributes: 'void *',
  TargetAlias: 'str16',
  UserName: 'str16'
})

interface CredApi {
  read: (target: string, type: number, flags: number, out: unknown[]) => boolean
  write: (cred: object, flags: number) => boolean
  remove: (target: string, type: number, flags: number) => boolean
  free: (p: unknown) => void
}
let credApi: CredApi | undefined
function api(): CredApi {
  if (!credApi) {
    const advapi32 = koffi.load('advapi32.dll')
    credApi = {
      read: advapi32.func('bool __stdcall CredReadW(str16 target, uint32 type, uint32 flags, _Out_ void **cred)'),
      write: advapi32.func('CredWriteW', 'bool', [koffi.pointer(CREDENTIALW), 'uint32']),
      remove: advapi32.func('bool __stdcall CredDeleteW(str16 target, uint32 type, uint32 flags)'),
      free: advapi32.func('void __stdcall CredFree(void *cred)')
    }
  }
  return credApi
}

// null quando a credencial não existe ou não deu para ler: nos dois casos não há login para consultar.
export function readGenericCredential(target: string): string | null {
  if (process.platform !== 'win32') return null
  const out: unknown[] = [null]
  if (!api().read(target, CRED_TYPE_GENERIC, 0, out)) return null
  try {
    const cred = koffi.decode(out[0], CREDENTIALW) as { CredentialBlobSize: number; CredentialBlob: unknown }
    if (!cred.CredentialBlobSize || !cred.CredentialBlob) return null
    const bytes = koffi.decode(cred.CredentialBlob, koffi.array('uint8', cred.CredentialBlobSize)) as number[]
    return Buffer.from(bytes).toString('utf8')
  } finally {
    api().free(out[0])
  }
}

export function writeGenericCredential(target: string, user: string, value: string): void {
  if (process.platform !== 'win32') throw new Error('O Cofre de Credenciais só existe no Windows')
  const blob = Buffer.from(value, 'utf8')
  const cred = {
    Flags: 0,
    Type: CRED_TYPE_GENERIC,
    TargetName: target,
    Comment: null,
    LastWrittenLow: 0,
    LastWrittenHigh: 0,
    CredentialBlobSize: blob.length,
    CredentialBlob: blob,
    Persist: CRED_PERSIST_LOCAL_MACHINE,
    AttributeCount: 0,
    Attributes: null,
    TargetAlias: null,
    UserName: user
  }
  if (!api().write(cred, 0)) throw new Error('O Windows recusou gravar o login no Cofre de Credenciais')
}

export function deleteGenericCredential(target: string): void {
  if (process.platform !== 'win32') return
  // Falhar com a credencial já ausente é o resultado pedido; o koffi não preserva o GetLastError, então a prova é a
  // leitura voltar vazia.
  if (!api().remove(target, CRED_TYPE_GENERIC, 0) && readGenericCredential(target) !== null) {
    throw new Error('O Windows recusou apagar o login do Cofre de Credenciais')
  }
}

export interface AgyCredentialStore {
  read(): string | null
  write(raw: string): void
  remove(): void
}

export const agyCredentialStore: AgyCredentialStore = {
  read: () => readGenericCredential(AGY_CREDENTIAL_TARGET),
  write: (raw) => writeGenericCredential(AGY_CREDENTIAL_TARGET, AGY_CREDENTIAL_USER, raw),
  remove: () => deleteGenericCredential(AGY_CREDENTIAL_TARGET)
}

// O agy aberto usa o token que leu ao abrir e não relê o cofre: trocar por baixo dele deixa a sessão na conta antiga,
// e a renovação dessa sessão pode gravar a conta antiga de volta.
export const isAgyProcess = (name: string): boolean => name.toLowerCase() === 'agy.exe'

function agyExe(): string | null {
  const base = process.env['LOCALAPPDATA']
  return base ? join(base, 'agy', 'bin', 'agy.exe') : null
}

let versionCache: { mtimeMs: number; version: Promise<string | null> } | null = null

// O servidor só devolve o grupo Gemini para versões recentes do CLI; perguntar ao executável acompanha as atualizações.
export async function agyVersion(): Promise<string | null> {
  const exe = agyExe()
  if (!exe) return null
  let mtimeMs: number
  try {
    mtimeMs = (await stat(exe)).mtimeMs
  } catch {
    return null
  }
  if (versionCache?.mtimeMs !== mtimeMs) {
    const version = new Promise<string | null>((resolve) => {
      execFile(exe, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        const match = /^\s*(\d+\.\d+\.\d+)\s*$/.exec(String(stdout))
        resolve(err || !match ? null : match[1]!)
      })
    })
    versionCache = { mtimeMs, version }
    // Falha não fica no cache: a próxima leitura tenta de novo.
    version.then((v) => {
      if (v === null && versionCache?.version === version) versionCache = null
    })
  }
  return versionCache.version
}

export const antigravitySource: AntigravitySource = {
  readCredential: () => readGenericCredential(AGY_CREDENTIAL_TARGET),
  version: agyVersion
}
