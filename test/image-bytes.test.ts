import { expect, it } from 'vitest'
import { imageTypeOf } from '../src/shared/image-bytes'

it('reconhece a imagem pelos primeiros bytes, e não pelo nome', () => {
  expect(imageTypeOf(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('image/png')
  expect(imageTypeOf(Buffer.from('ffd8ffe000104a46', 'hex'))).toBe('image/jpeg')
  expect(imageTypeOf(Buffer.from('GIF89a'))).toBe('image/gif')
  expect(imageTypeOf(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp')
  for (const other of ['%PDF-1.4', 'PK\x03\x04', 'RIFF\x10\x00\x00\x00WAVE', '', 'II*\x00']) expect(imageTypeOf(Buffer.from(other, 'latin1'))).toBeNull()
})
