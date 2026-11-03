const ascii = (bytes: Uint8Array, from: number, text: string): boolean =>
  [...text].every((char, index) => bytes[from + index] === char.charCodeAt(0))

// O tipo de verdade, pelos primeiros bytes: o app Android antigo entrega qualquer arquivo como "imagem-<n>.jpg",
// e um PDF anexado como imagem trava a conversa no agente.
export function imageTypeOf(head: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (head[0] === 0x89 && ascii(head, 1, 'PNG')) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (ascii(head, 0, 'GIF8')) return 'image/gif'
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'image/webp'
  return null
}
