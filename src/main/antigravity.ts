import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import koffi from 'koffi'
import type { AntigravitySource } from './usage'

const CRED_TYPE_GENERIC = 1
// Onde o agy guarda o login (go-keyring no Cofre de Credenciais do Windows).
const AGY_CREDENTIAL_TARGET = 'gemini:antigravity'
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

let credApi: { read: (target: string, type: number, flags: number, out: unknown[]) => boolean; free: (p: unknown) => void } | undefined
function api(): NonNullable<typeof credApi> {
  if (!credApi) {
    const advapi32 = koffi.load('advapi32.dll')
    credApi = {
      read: advapi32.func('bool __stdcall CredReadW(str16 target, uint32 type, uint32 flags, _Out_ void **cred)'),
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
