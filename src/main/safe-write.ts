import { closeSync, fsyncSync, ftruncateSync, openSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import koffi from 'koffi'
import { isBlocked, renameRetrying } from './durable-file'

const FILE_ATTRIBUTE_READONLY = 0x1
const FILE_ATTRIBUTE_HIDDEN = 0x2
const FILE_ATTRIBUTE_SYSTEM = 0x4
const INVALID_FILE_ATTRIBUTES = 0xffffffff

let getAttributes: ((path: string) => number) | null | undefined
function windowsAttributes(path: string): number {
  if (getAttributes === undefined) {
    getAttributes =
      process.platform === 'win32'
        ? (koffi.load('kernel32.dll').func('uint32 __stdcall GetFileAttributesW(str16 lpFileName)') as (path: string) => number)
        : null
  }
  const attributes = getAttributes?.(path) ?? 0
  return attributes === INVALID_FILE_ATTRIBUTES ? 0 : attributes
}

type StreamApi = {
  first: (path: string, level: number, data: object, flags: number) => unknown
  next: (handle: unknown, data: object) => boolean
  close: (handle: unknown) => boolean
}
let streamApi: StreamApi | null | undefined
// Só o fluxo principal "::$DATA" vai para o temporário; qualquer outro (Zone.Identifier do download, metadados de
// outro programa) sumiria na troca de nome.
function hasAlternateStreams(path: string): boolean {
  if (streamApi === undefined) {
    if (process.platform !== 'win32') streamApi = null
    else {
      const kernel32 = koffi.load('kernel32.dll')
      const data = koffi.struct({ StreamSize: 'int64', cStreamName: koffi.array('char16_t', 296, 'String') })
      streamApi = {
        first: kernel32.func('__stdcall', 'FindFirstStreamW', 'void*', ['str16', 'int', koffi.out(koffi.pointer(data)), 'uint32']),
        next: kernel32.func('__stdcall', 'FindNextStreamW', 'bool', ['void*', koffi.out(koffi.pointer(data))]),
        close: kernel32.func('bool __stdcall FindClose(void*)')
      }
    }
  }
  if (!streamApi) return false
  const entry = { cStreamName: '' }
  const handle = streamApi.first(path, 0, entry, 0)
  if (!handle || koffi.address(handle) === 0xffffffffffffffffn) return false
  try {
    do {
      if (entry.cStreamName !== '::$DATA') return true
    } while (streamApi.next(handle, entry))
    return false
  } finally {
    streamApi.close(handle)
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.length; ) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset)
}

// 'r+' abre o arquivo que já existe sem recriá-lo: o Windows recusa o CREATE_ALWAYS do 'w' em arquivo oculto (EPERM),
// e assim ficam o atributo, a ACL, os outros hard links e os fluxos alternativos.
// Daqui em diante o original deixa de estar intacto: o temporário, já no disco, segue com um nome que o usuário
// reconhece até a escrita terminar, e é o que sobra se ela parar no meio (erro ou queda de energia).
function writeInPlace(file: string, tmp: string, bytes: Uint8Array, rel: string): void {
  const ext = extname(file)
  const copy = join(dirname(file), `${basename(file, ext)}.kora-recuperado-${randomBytes(4).toString('hex')}${ext}`)
  renameRetrying(tmp, copy)
  let fd: number
  try {
    fd = openSync(file, 'r+')
  } catch (err) {
    rmSync(copy, { force: true })
    throw err
  }
  try {
    writeAll(fd, bytes)
    ftruncateSync(fd, bytes.length)
    fsyncSync(fd)
  } catch (err) {
    const reason = saveError(err, rel)
    throw Object.assign(
      new Error(`${reason.message} O arquivo pode ter ficado incompleto; o texto salvo inteiro está em ${basename(copy)}.`),
      { code: (err as NodeJS.ErrnoException).code, recovered: true }
    )
  } finally {
    closeSync(fd)
  }
  rmSync(copy, { force: true })
}

export function saveError(err: unknown, rel: string): Error {
  const code = (err as NodeJS.ErrnoException).code
  const message =
    code === 'EBUSY'
      ? `O arquivo está aberto em outro programa que impede a gravação: ${rel}. Feche o programa e salve de novo.`
      : code === 'EPERM' || code === 'EACCES'
        ? `Sem permissão para gravar o arquivo: ${rel}.`
        : code === 'ENOSPC'
          ? `Disco cheio: não foi possível salvar ${rel}.`
          : null
  return message ? Object.assign(new Error(message), { code }) : (err as Error)
}

// Gravar por cima direto trunca o arquivo antes de escrever: queda de energia, processo morto ou disco cheio no meio
// deixam o arquivo do usuário zerado ou pela metade. O texto novo vai inteiro para um temporário na mesma pasta,
// chega ao disco (fsync) e só então troca de nome com o original, que até ali segue intacto.
// A troca de nome cria um arquivo novo no lugar, então quando o original tem algo que ela perderia (outro hard link,
// atributo oculto/sistema, fluxo alternativo do NTFS) ou está aberto num programa que não deixa renomear (sem FILE_SHARE_DELETE, como o
// Excel e muitos editores), grava no próprio arquivo, mas só depois de o temporário provar que o texto cabe no disco.
// Link simbólico: grava no alvo, o link continua link.
export function replaceFileContents(path: string, bytes: Uint8Array, rel: string): void {
  const file = realpathSync.native(path)
  const attributes = windowsAttributes(file)
  const info = statSync(file)
  if (attributes & FILE_ATTRIBUTE_READONLY || !(info.mode & 0o200)) {
    throw new Error(`O arquivo é somente leitura: ${rel}. Tire o "Somente leitura" nas propriedades do arquivo para salvar.`)
  }
  const keepIdentity =
    info.nlink > 1 || (attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) !== 0 || hasAlternateStreams(file)
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.kora-tmp`)
  try {
    const fd = openSync(tmp, 'wx')
    try {
      writeAll(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (!keepIdentity) {
      try {
        renameRetrying(tmp, file)
        return
      } catch (err) {
        if (!isBlocked(err)) throw err
      }
    }
    writeInPlace(file, tmp, bytes, rel)
  } catch (err) {
    throw (err as { recovered?: boolean }).recovered ? err : saveError(err, rel)
  } finally {
    rmSync(tmp, { force: true })
  }
}
