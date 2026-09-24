import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}
export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024

// O Claude Code e o Codex anexam imagem quando recebem o caminho de um arquivo de imagem colado no prompt,
// o mesmo que acontece ao arrastar um arquivo; por isso o print vira arquivo e o terminal recebe o caminho.
export function savePastedImage(dir: string, bytes: Uint8Array, mime: string): string {
  const ext = EXTENSIONS[mime]
  if (!ext) throw new Error(`Tipo de imagem não suportado: ${mime}`)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PASTED_IMAGE_BYTES) {
    throw new Error('Imagem vazia ou grande demais para colar.')
  }
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `print-${stamp}-${randomUUID().slice(0, 8)}.${ext}`)
  writeFileSync(file, bytes)
  return file
}
