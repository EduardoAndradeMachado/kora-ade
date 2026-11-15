import { readFileSync, statSync } from 'node:fs'
import { resolveInside } from './files'
import { OPEN_LIMITS } from '../shared/open-limits'

// Teto do "Abrir mesmo assim" da planilha: o .xlsx descompactado no renderer ocupa várias vezes isso.
export const MAX_FORCED_SHEET_BYTES = OPEN_LIMITS.forcedSheetBytes

// Os bytes do .xlsx para o leitor do renderer, com os mesmos limites (e as mesmas mensagens, que o renderer
// reconhece pelo começo) do readText. A leitura do pacote fica no renderer: travar o main com um arquivo grande
// travaria todas as janelas e terminais.
export function readSheetBytes(root: string, rel: string, opts: { force?: boolean } = {}): Uint8Array {
  const file = resolveInside(root, rel)
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`Não é um arquivo: ${rel}`)
  if (stat.size > MAX_FORCED_SHEET_BYTES) throw new Error(`Arquivo acima de ${MAX_FORCED_SHEET_BYTES / 1024 / 1024} MB, abra no programa padrão: ${rel}`)
  if (stat.size > OPEN_LIMITS.sheetBytes && !opts.force) throw new Error(`Arquivo grande demais para abrir aqui: ${rel}`)
  const bytes = readFileSync(file)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
