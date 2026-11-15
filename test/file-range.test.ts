import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rangeResponse } from '../src/main/file-request'

let dir: string
let file: string
const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i))

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kora-range-'))
  file = join(dir, 'video.mp4')
  writeFileSync(file, bytes)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function partial(header: string): Promise<{ status: number; range: string | null; length: string | null; body: Buffer }> {
  const res = await rangeResponse(file, header)
  if (!res) throw new Error(`Range ignorado: ${header}`)
  return {
    status: res.status,
    range: res.headers.get('content-range'),
    length: res.headers.get('content-length'),
    body: Buffer.from(await res.arrayBuffer())
  }
}

describe('rangeResponse', () => {
  it('entrega só a faixa pedida com 206 e Content-Range, que é o que deixa o <video> pular para o meio', async () => {
    const res = await partial('bytes=10-19')
    expect(res).toEqual({ status: 206, range: 'bytes 10-19/100', length: '10', body: bytes.subarray(10, 20) })
  })

  it('aceita faixa aberta e faixa pelo fim', async () => {
    expect(await partial('bytes=95-')).toEqual({ status: 206, range: 'bytes 95-99/100', length: '5', body: bytes.subarray(95) })
    expect(await partial('bytes=-3')).toEqual({ status: 206, range: 'bytes 97-99/100', length: '3', body: bytes.subarray(97) })
  })

  it('corta o fim pedido além do tamanho do arquivo', async () => {
    expect(await partial('bytes=90-500')).toMatchObject({ status: 206, range: 'bytes 90-99/100', body: bytes.subarray(90) })
  })

  it('responde 416 quando a faixa começa depois do fim', async () => {
    expect(await partial('bytes=100-')).toMatchObject({ status: 416, range: 'bytes */100' })
  })

  it('ignora Range malformado, invertido ou com várias faixas: o arquivo vai inteiro pelo caminho normal', async () => {
    for (const header of ['bytes=0-1,5-6', 'bytes=20-10', 'items=0-5', 'bytes=-']) {
      expect(await rangeResponse(file, header)).toBeNull()
    }
  })

  it('declara o tipo do vídeo pela extensão', async () => {
    expect((await rangeResponse(file, 'bytes=0-'))?.headers.get('content-type')).toBe('video/mp4')
  })
})
