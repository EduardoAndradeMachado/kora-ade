import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const MAX_PASTED_FILE_BYTES = 20 * 1024 * 1024
const MAX_NAME = 120
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

// O nome que o agente vê precisa ser o do celular ("contrato.pdf"), mas vem de fora: só o último trecho, sem os
// caracteres que o Windows recusa, sem nome de dispositivo, que viraria outro destino, e sem o que algum shell
// interpreta ($(), ;, &, %, crase): o caminho é colado no terminal, e o agente pode ter saído para o PowerShell.
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  // oxlint-disable-next-line no-control-regex
  let clean = base.replace(/[<>:"|?*\x00-\x1f$`'();&%^!{}[\]~]/g, '_').replace(/[. ]+$/, '').trim()
  if (clean.length > MAX_NAME) {
    const dot = clean.lastIndexOf('.')
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
    clean = clean.slice(0, MAX_NAME - ext.length) + ext
  }
  if (clean === '' || /^\.+$/.test(clean)) return 'arquivo'
  return RESERVED.test(clean) ? `_${clean}` : clean
}

// Cada envio ganha uma pasta própria: dois arquivos com o mesmo nome não se sobrescrevem e o nome fica intacto.
export function savePastedFile(dir: string, bytes: Uint8Array, name: string): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PASTED_FILE_BYTES) {
    throw new Error('Arquivo vazio ou grande demais para anexar.')
  }
  const folder = join(dir, randomUUID())
  mkdirSync(folder, { recursive: true })
  const file = join(folder, safeFileName(name))
  try {
    writeFileSync(file, bytes)
  } catch (error) {
    // Disco cheio no meio: o pedaço gravado não serve e não fica ocupando espaço.
    rmSync(folder, { recursive: true, force: true })
    throw error
  }
  return file
}
