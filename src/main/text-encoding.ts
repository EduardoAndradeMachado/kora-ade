import { TEXT_ENCODINGS, type TextEncodingId } from '../shared/text-encodings'

export type { TextEncodingId }

export const ENCODING_LABEL = Object.fromEntries(TEXT_ENCODINGS.map((e) => [e.id, e.label])) as Record<TextEncodingId, string>

const BOM = '﻿'
const BINARY_SAMPLE_BYTES = 8192

// Windows-1252 difere do Latin-1 só em 0x80–0x9F. Os cinco bytes sem caractere (81, 8D, 8F, 90, 9D) viram o
// controle C1 de mesmo número, como no TextDecoder: assim todo byte tem ida e volta e nada se perde ao salvar.
// A tabela é nossa em vez do TextDecoder('windows-1252') porque esse depende do ICU completo, e o Node do
// Electron não garante; o 'latin1' do Buffer não depende de nada.
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178
]
const CP1252_HIGH_CHARS = String.fromCharCode(...CP1252_HIGH)
const CP1252_BYTE = new Map(CP1252_HIGH.map((code, i) => [code, 0x80 + i]))

export class UnencodableError extends Error {}

const isUtf16Le = (b: Buffer): boolean => b.length % 2 === 0 && b[0] === 0xff && b[1] === 0xfe
const isUtf16Be = (b: Buffer): boolean => b.length % 2 === 0 && b[0] === 0xfe && b[1] === 0xff
const hasUtf8Bom = (b: Buffer): boolean => b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

// UTF-16 com tamanho ímpar não é UTF-16 de verdade: decodificar perderia o último byte ao salvar.
export function detectEncoding(bytes: Buffer): TextEncodingId {
  if (hasUtf8Bom(bytes)) return 'utf8bom'
  if (isUtf16Le(bytes)) return 'utf16le'
  if (isUtf16Be(bytes)) return 'utf16be'
  return isValidUtf8(bytes) ? 'utf8' : 'cp1252'
}

// UTF-16 tem byte 0 em todo caractere ASCII; fora dele, um 0 no começo do arquivo é sinal de binário.
export function looksBinary(bytes: Buffer, encoding: TextEncodingId): boolean {
  if (encoding === 'utf16le' || encoding === 'utf16be') return false
  return bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)
}

function utf16Body(bytes: Buffer, bom: readonly [number, number], label: string): Buffer {
  const body = bytes[0] === bom[0] && bytes[1] === bom[1] ? bytes.subarray(2) : bytes
  if (body.length % 2 !== 0) throw new Error(`O arquivo tem um número ímpar de bytes, então não está em ${label}.`)
  return body
}

// O BOM fica no texto (U+FEFF no começo) nas codificações que o gravam: o Monaco guarda e devolve com
// getValue(..., true). A codificação pode ter sido escolhida pelo usuário ("Reabrir com codificação"), então o BOM
// do disco só é tirado quando é o da própria codificação; um arquivo sem BOM aberto como UTF-16 decodifica inteiro.
export function decodeText(bytes: Buffer, encoding: TextEncodingId): string {
  switch (encoding) {
    case 'utf8':
      return (hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes).toString('utf8')
    case 'utf8bom':
      return BOM + (hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes).toString('utf8')
    case 'utf16le':
      return BOM + utf16Body(bytes, [0xff, 0xfe], ENCODING_LABEL.utf16le).toString('utf16le')
    case 'utf16be':
      return BOM + Buffer.from(utf16Body(bytes, [0xfe, 0xff], ENCODING_LABEL.utf16be)).swap16().toString('utf16le')
    case 'cp1252':
      return bytes.toString('latin1').replace(/[\x80-\x9f]/g, (c) => CP1252_HIGH_CHARS.charAt(c.charCodeAt(0) - 0x80))
    case 'latin1':
      return bytes.toString('latin1')
  }
}

function singleByte(code: number, encoding: 'cp1252' | 'latin1'): number | undefined {
  if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code
  if (encoding === 'latin1') return code <= 0xff ? code : undefined
  return CP1252_BYTE.get(code)
}

function encodeSingleByte(text: string, encoding: 'cp1252' | 'latin1'): Buffer {
  const out = Buffer.alloc(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const byte = singleByte(code, encoding)
    if (byte === undefined) {
      const char = String.fromCodePoint(text.codePointAt(i) ?? code)
      const line = text.slice(0, i).split('\n').length
      throw new UnencodableError(
        `A codificação ${ENCODING_LABEL[encoding]} não tem o caractere "${char}" (linha ${line}). Tire o caractere ou salve com outra codificação.`
      )
    }
    out[i] = byte
  }
  return out
}

// Nas codificações com BOM o BOM é recolocado mesmo se quem salva mandou o texto sem ele, e no UTF-8 sem BOM ele
// sai mesmo se veio no texto: a codificação é a do arquivo no disco (ou a escolhida no "Salvar com codificação"),
// não a do texto recebido.
export function encodeText(text: string, encoding: TextEncodingId): Buffer {
  const body = text.startsWith(BOM) ? text.slice(1) : text
  switch (encoding) {
    case 'utf8':
      return Buffer.from(body, 'utf8')
    case 'utf8bom':
      return Buffer.from(BOM + body, 'utf8')
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body, 'utf16le').swap16()])
    case 'cp1252':
    case 'latin1':
      return encodeSingleByte(text, encoding)
  }
}

// Fim de linha predominante; arquivo sem quebra de linha não tem um.
export function detectEol(text: string): 'LF' | 'CRLF' | undefined {
  let crlf = 0
  let lf = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (text.charCodeAt(i - 1) === 13) crlf++
    else lf++
  }
  if (crlf === 0 && lf === 0) return undefined
  return crlf > lf ? 'CRLF' : 'LF'
}
