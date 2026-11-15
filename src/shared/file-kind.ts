export type Viewer = 'markdown' | 'code' | 'pdf' | 'image' | 'media' | 'notebook' | 'sheet' | 'external'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])
// Só o que o Chromium do Electron toca sozinho; mkv e avi ficam com o programa do Windows.
// `.ts` não entra mesmo sendo vídeo MPEG-TS: aqui ele é TypeScript.
const MEDIA = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov'])
const SHEET = new Set(['csv', 'tsv', 'xlsx'])
const EXTERNAL = new Set([
  'exe', 'dll', 'msi', 'bin', 'zip', '7z', 'rar', 'gz', 'tar', 'tgz',
  'doc', 'docx', 'xls', 'ppt', 'pptx', 'odt',
  'mkv', 'avi',
  'woff', 'woff2', 'ttf', 'otf', 'psd', 'sqlite', 'db'
])

export function viewerFor(path: string): Viewer {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'ipynb') return 'notebook'
  // Do Excel, só o .xlsx: o leitor conhece o pacote dele, e o .xls (binário antigo) fica com o programa do Windows.
  if (SHEET.has(ext)) return 'sheet'
  if (IMAGE.has(ext)) return 'image'
  if (MEDIA.has(ext)) return 'media'
  if (EXTERNAL.has(ext)) return 'external'
  return 'code'
}
