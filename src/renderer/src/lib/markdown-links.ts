import { koraFileUrl } from '../../../shared/file-url'
import { splitLineSuffix } from '../../../shared/terminal-links'

export type MarkdownLink =
  | { kind: 'none' }
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'file'; rel: string; line: number | null; anchor: string | null }
  | { kind: 'blocked'; message: string }

// Duas letras no mínimo: `C:/pasta` é caminho do Windows, não scheme.
const SCHEME = /^[a-z][a-z0-9+.-]+:/i

// O padrão do DOMPurify mais `arquivo.ext:linha`: sem isso ele lê "app.ts:" como scheme desconhecido e tira o href,
// e o link nunca chega ao resolveMarkdownHref. Scheme perigoso (javascript:, data:) continua de fora.
export const ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$)|[\w.-]+\.[a-z0-9]+:\d+(?:[:#]|$))/i
const EXTERNAL = /^(https?|mailto):/i
const INLINE_IMAGE = /^(https?|data|blob):/i

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

// Relativo à pasta do .md, como no GitHub; `/` no começo é a raiz do projeto. Devolve o caminho no formato do
// resto do app (separado por `\`), '' para a própria raiz, ou null quando sai do projeto ou é absoluto: o
// protocolo kora-file não recebe `..` porque o Chromium resolveria o segmento antes de chegar ao main.
export function resolveProjectPath(docPath: string, target: string): string | null {
  const normalized = target.replace(/\\/g, '/')
  if (/^[a-z]:/i.test(normalized) || normalized.startsWith('//')) return null
  const parts = normalized.startsWith('/') ? [] : docPath.split(/[\\/]/).filter((s) => s !== '').slice(0, -1)
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') parts.push(segment)
    else if (parts.length === 0) return null
    else parts.pop()
  }
  return parts.join('\\')
}

export function resolveMarkdownHref(href: string, docPath: string): MarkdownLink {
  const raw = href.trim()
  if (raw === '') return { kind: 'none' }
  if (raw.startsWith('#')) return { kind: 'anchor', anchor: decode(raw.slice(1)) }
  if (EXTERNAL.test(raw)) return { kind: 'external', url: raw }
  if (SCHEME.test(raw)) return { kind: 'blocked', message: 'Tipo de link não suportado' }

  const hashAt = raw.indexOf('#')
  const fragment = hashAt === -1 ? '' : raw.slice(hashAt + 1)
  const pathPart = (hashAt === -1 ? raw : raw.slice(0, hashAt)).replace(/\?.*$/, '')
  const { path, line: suffixLine } = splitLineSuffix(decode(pathPart))
  const rel = resolveProjectPath(docPath, path)
  if (rel === null) return { kind: 'blocked', message: 'O link aponta para fora do projeto' }
  // #L10 e #L10-L20 são os links de linha do GitHub; outro fragmento é a seção (cabeçalho) do arquivo de destino.
  const lineMatch = /^L(\d+)(?:-L?\d+)?$/.exec(fragment)
  const line = lineMatch ? Number(lineMatch[1]) : suffixLine
  const anchor = lineMatch || fragment === '' ? null : decode(fragment)
  return { kind: 'file', rel, line: line && line > 0 ? line : null, anchor }
}

// `leia.md#uso` escrito dentro do próprio leia.md é a âncora do documento aberto, não outro arquivo.
export function isSameDocument(rel: string, docPath: string): boolean {
  const normalize = (p: string): string => p.replace(/\//g, '\\').toLowerCase()
  return normalize(rel) === normalize(docPath)
}

// O link de leitura do celular (`/raw/<chave>/<caminho>`) só entrega o que está na pasta do arquivo aberto e abaixo
// dela, sem nada oculto no caminho a partir dali (a regra é do mobile-server). Para o resto, quem chama pede um link
// próprio do arquivo: devolve null.
export function mobileRawUrl(raw: string, docPath: string, rel: string): string | null {
  const prefix = /^\/raw\/[^/]+\//.exec(raw)?.[0]
  if (!prefix) return null
  const folder = docPath.split(/[\\/]/).filter(Boolean).slice(0, -1)
  const parts = rel.split(/[\\/]/).filter(Boolean)
  if (parts.length <= folder.length || folder.some((segment, i) => segment !== parts[i])) return null
  if (parts.slice(folder.length).some((segment) => segment.startsWith('.'))) return null
  return prefix + parts.map(encodeURIComponent).join('/')
}

// http(s) e data: ficam como estão (a CSP decide o remoto); o resto vira arquivo do projeto ou null (imagem
// quebrada), inclusive kora-file: escrito à mão, que poderia apontar para outro projeto.
export function resolveImageSrc(src: string, docPath: string, projectId: string): string | null {
  const image = resolveImage(src, docPath)
  if (!image) return null
  return image.kind === 'inline' ? image.url : koraFileUrl(projectId, image.rel)
}

// A parte comum ao PC e ao celular: cada um monta a URL do arquivo do projeto do seu jeito.
export function resolveImage(src: string, docPath: string): { kind: 'inline'; url: string } | { kind: 'file'; rel: string } | null {
  const raw = src.trim()
  if (raw === '') return null
  if (INLINE_IMAGE.test(raw)) return { kind: 'inline', url: raw }
  if (SCHEME.test(raw)) return null
  const rel = resolveProjectPath(docPath, decode(raw.replace(/[?#].*$/, '')))
  return rel ? { kind: 'file', rel } : null
}

// O cabeçalho pelo slug (data-anchor) e, para HTML escrito à mão no .md, id e <a name>.
export function findAnchor(article: Element, anchor: string): Element | null {
  for (const name of new Set([anchor, anchor.toLowerCase()])) {
    const escaped = CSS.escape(name)
    const found = article.querySelector(`[data-anchor="${escaped}"], [id="${escaped}"], a[name="${escaped}"]`)
    if (found) return found
  }
  return null
}

// Mesmo algoritmo do github-slugger (o que gera as âncoras dos cabeçalhos no GitHub): minúsculas, sem pontuação,
// espaço vira hífen e repetido ganha -1, -2... `seen` é por documento.
export function headingSlug(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
  let slug = base
  while (seen.has(slug)) {
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    slug = `${base}-${n}`
  }
  seen.set(slug, 0)
  return slug
}
