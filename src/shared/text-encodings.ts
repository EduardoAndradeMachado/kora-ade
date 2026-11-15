// Só codificações que o main codifica e decodifica com tabela própria ou com o Buffer do Node. As outras do VS Code
// (Shift-JIS, GBK, KOI8...) dependeriam do ICU completo para ler e de uma biblioteca nova para gravar.
export const TEXT_ENCODINGS = [
  { id: 'utf8', label: 'UTF-8' },
  { id: 'utf8bom', label: 'UTF-8 com BOM' },
  { id: 'utf16le', label: 'UTF-16 LE' },
  { id: 'utf16be', label: 'UTF-16 BE' },
  { id: 'cp1252', label: 'Windows-1252', detail: 'Europa Ocidental' },
  { id: 'latin1', label: 'ISO-8859-1', detail: 'Latin-1' }
] as const

export type TextEncodingId = (typeof TEXT_ENCODINGS)[number]['id']
