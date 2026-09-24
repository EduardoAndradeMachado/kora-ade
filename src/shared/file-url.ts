export const KORA_FILE_SCHEME = 'kora-file'

// Host fixo em vez do id do projeto: num scheme "standard" o Chromium normaliza o host para
// minúsculas, então qualquer id com maiúscula chegaria diferente no main.
const HOST = 'project'
const PREFIX = `${KORA_FILE_SCHEME}://${HOST}/`

export interface KoraFileRef {
  projectId: string
  rel: string
}

// Cada segmento é codificado à parte: `#`, `?`, `%` e espaço em nome de arquivo precisam
// chegar ao main como parte do nome, não como fragmento/query/escape.
export function koraFileUrl(projectId: string, rel: string): string {
  const segments = rel.split(/[\\/]/).filter((s) => s !== '')
  return PREFIX + [projectId, ...segments].map(encodeURIComponent).join('/')
}

export function parseKoraFileUrl(url: string): KoraFileRef {
  const parsed = new URL(url)
  if (parsed.protocol !== `${KORA_FILE_SCHEME}:` || parsed.host !== HOST) {
    throw new Error(`URL não é do ${KORA_FILE_SCHEME}: ${url}`)
  }
  const [projectId, ...segments] = parsed.pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => decodeURIComponent(s))
  if (!projectId || segments.length === 0) throw new Error(`URL sem projeto ou arquivo: ${url}`)
  return { projectId, rel: segments.join('/') }
}

// Caminho do Windows como URL file:// que um navegador abre (espaço, #, % e acentos escapados por trecho).
// Caminho de rede (\\servidor\pasta) vira file://servidor/pasta.
export function windowsFileUrl(path: string): string {
  const unc = path.startsWith('\\\\')
  const parts = (unc ? path.slice(2) : path).split(/[\\/]/)
  const encoded = parts.map((part, i) => (i === 0 && (unc || /^[A-Za-z]:$/.test(part)) ? part : encodeURIComponent(part)))
  return unc ? `file://${encoded.join('/')}` : `file:///${encoded.join('/')}`
}
