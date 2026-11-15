import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { resolveInside } from './files'
import { parseKoraFileUrl } from '../shared/file-url'

export class KoraFileError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string
  ) {
    super(message)
  }
}

// Separado do registro do protocolo para ser testável sem o runtime do Electron.
export function resolveKoraFileRequest(url: string, getProjectRoot: (id: string) => string): string {
  let ref
  try {
    ref = parseKoraFileUrl(url)
  } catch (err) {
    throw new KoraFileError(400, (err as Error).message)
  }
  let root: string
  try {
    root = getProjectRoot(ref.projectId)
  } catch (err) {
    throw new KoraFileError(404, (err as Error).message)
  }
  try {
    return resolveInside(root, ref.rel)
  } catch (err) {
    throw new KoraFileError(403, (err as Error).message)
  }
}

export interface ByteRange {
  start: number
  end: number
}

// RFC 9110 §14.2: Range malformado, com várias faixas ou invertido é ignorado (resposta inteira, null);
// faixa bem formada que começa depois do fim do arquivo é 416.
export function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '')
  if (!match) return null
  const [, first, last] = match
  if (first === '' && last === '') return null
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (last !== '' && Number(last) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) }
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf'
}

// O net.fetch de file:// recebe o Range mas responde 200 sem Content-Range: o <video> não consegue pular
// para o meio. Devolve null quando o Range não se aplica e o arquivo deve ir inteiro.
export async function rangeResponse(file: string, header: string): Promise<Response | null> {
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`Não é um arquivo: ${file}`)
  const range = parseByteRange(header, info.size)
  if (range === null) return null
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
  }
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  const body = Readable.toWeb(createReadStream(file, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>
  return new Response(body, {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`
    }
  })
}
