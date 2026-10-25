import { cpSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// O pdf.js do celular busca decodificadores de imagem (JPEG 2000, JBIG2 de PDF escaneado), fontes padrão e mapas de
// caracteres por URL. O Kora do PC serve estas pastas (/pdfjs/...); no instalador elas vão em resources/pdfjs.
export const PDFJS_ASSETS = ['wasm', 'cmaps', 'standard_fonts', 'iccs'] as const

const from = resolve('node_modules', 'pdfjs-dist')
const to = resolve('resources', 'pdfjs')
rmSync(to, { recursive: true, force: true })
for (const dir of PDFJS_ASSETS) cpSync(join(from, dir), join(to, dir), { recursive: true })
console.log(`pdf.js do celular em resources/pdfjs (${PDFJS_ASSETS.join(', ')})`)
