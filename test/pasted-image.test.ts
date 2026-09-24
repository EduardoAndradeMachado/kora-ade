import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_PASTED_IMAGE_BYTES, savePastedImage } from '../src/main/pasted-image'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('imagem colada no terminal', () => {
  it('grava os bytes num arquivo com a extensão do tipo e devolve o caminho', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'kora-paste-')), 'sub')
    const file = savePastedImage(dir, PNG_1X1, 'image/png')
    expect(dirname(file)).toBe(dir)
    expect(file.endsWith('.png')).toBe(true)
    expect(readFileSync(file).equals(PNG_1X1)).toBe(true)
    expect(savePastedImage(dir, PNG_1X1, 'image/jpeg').endsWith('.jpg')).toBe(true)
  })

  it('dois prints seguidos não se sobrescrevem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-paste-'))
    expect(savePastedImage(dir, PNG_1X1, 'image/png')).not.toBe(savePastedImage(dir, PNG_1X1, 'image/png'))
  })

  it('recusa tipo que não é imagem, vazio e grande demais', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-paste-'))
    expect(() => savePastedImage(dir, PNG_1X1, 'text/html')).toThrow(/não suportado/)
    expect(() => savePastedImage(dir, new Uint8Array(), 'image/png')).toThrow(/vazia/)
    expect(() => savePastedImage(dir, new Uint8Array(MAX_PASTED_IMAGE_BYTES + 1), 'image/png')).toThrow(/grande/)
  })
})
