export type Viewer = 'markdown' | 'code' | 'pdf' | 'image' | 'external'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])
const EXTERNAL = new Set([
  'exe', 'dll', 'msi', 'bin', 'zip', '7z', 'rar', 'gz', 'tar', 'tgz',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mkv', 'mov', 'avi', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'psd', 'sqlite', 'db'
])

export function viewerFor(path: string): Viewer {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (IMAGE.has(ext)) return 'image'
  if (EXTERNAL.has(ext)) return 'external'
  return 'code'
}
