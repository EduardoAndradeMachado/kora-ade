import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'

export const MAX_ICON_BYTES = 256 * 1024
const MAX_HTML_BYTES = 256 * 1024
const MAX_CHILD_DIRS = 24

export interface ProjectIcon {
  // SVG vem como data URL: seguro só dentro de <img src>, que não executa script. Nunca injetar via innerHTML.
  dataUrl: string
  // Relativo à raiz do projeto, sempre com '/'.
  source: string
}

// Ordem = prioridade. Ícone quadrado feito para aba/app vem antes de logo (costuma ser wordmark largo).
// `app/icon` é a convenção de metadados do Next App Router: quando existe, é o favicon real do site.
const STEMS = [
  'app/icon',
  'src/app/icon',
  'public/favicon',
  'favicon',
  'app/favicon',
  'src/app/favicon',
  'static/favicon',
  'assets/favicon',
  'src/favicon',
  'src/assets/favicon',
  'public/icon',
  'icon',
  'assets/icon',
  'static/icon',
  'resources/icon',
  'build/icon',
  'src-tauri/icons/icon',
  'public/apple-touch-icon',
  'apple-touch-icon',
  'app/apple-icon',
  'src/app/apple-icon',
  'public/logo',
  'logo',
  'assets/logo',
  'src/assets/logo',
  'static/logo',
  '.github/logo',
  'docs/logo'
]
const EXTS = ['.svg', '.png', '.webp', '.ico', '.jpg', '.jpeg']
const CANDIDATES = STEMS.flatMap((stem) => EXTS.map((ext) => stem + ext))
const CANDIDATE_DIRS = [...new Set(CANDIDATES.map((c) => posix.dirname(c)))]

const HTML_FILES = ['index.html', 'public/index.html', 'src/index.html']

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'coverage',
  'target'
])

// Logos que vêm no template do Vite/Next: apontam pro framework, não pro projeto.
const PLACEHOLDERS = new Set(['vite.svg', 'next.svg', 'vercel.svg', 'react.svg'])

export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (buf.length >= 6 && buf.readUInt32BE(0) === 0x00000100 && buf.readUInt16LE(4) > 0) return 'image/x-icon'
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096)).replace(/^﻿/, '')
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

const toAbs = (root: string, rel: string): string => join(root, ...rel.split('/'))

async function loadIcon(root: string, rel: string): Promise<ProjectIcon | null> {
  if (PLACEHOLDERS.has(posix.basename(rel).toLowerCase())) return null
  try {
    const abs = toAbs(root, rel)
    const info = await stat(abs)
    if (!info.isFile() || info.size === 0 || info.size > MAX_ICON_BYTES) return null
    const buf = await readFile(abs)
    if (buf.length > MAX_ICON_BYTES) return null
    const mime = sniffImageMime(buf)
    if (!mime) return null
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, source: rel }
  } catch {
    return null
  }
}

// Lista cada pasta candidata uma vez em vez de dar stat em ~170 caminhos: no Windows cada stat custa caro.
async function findKnown(root: string): Promise<{ icon: ProjectIcon; rank: number } | null> {
  const listings = new Map<string, Map<string, string>>()
  await Promise.all(
    CANDIDATE_DIRS.map(async (dir) => {
      try {
        const entries = await readdir(dir === '.' ? root : toAbs(root, dir), { withFileTypes: true })
        const names = new Map<string, string>()
        for (const e of entries) if (e.isFile() || e.isSymbolicLink()) names.set(e.name.toLowerCase(), e.name)
        listings.set(dir, names)
      } catch {
        // pasta inexistente é o caso comum
      }
    })
  )
  for (const [rank, candidate] of CANDIDATES.entries()) {
    const dir = posix.dirname(candidate)
    const actual = listings.get(dir)?.get(posix.basename(candidate))
    if (!actual) continue
    const icon = await loadIcon(root, dir === '.' ? actual : `${dir}/${actual}`)
    if (icon) return { icon, rank }
  }
  return null
}

function iconHrefs(html: string): string[] {
  const hrefs: string[] = []
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, 'rel')?.toLowerCase().split(/\s+/) ?? []
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue
    const href = attr(tag, 'href')
    if (href) hrefs.push(href)
  }
  return hrefs
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
}

// Resolve como o dev server faria: '/x' é a raiz servida (public/ no Vite); relativo é a partir do HTML.
function resolveHref(href: string, htmlRel: string): string[] {
  const clean = href.trim().split(/[?#]/)[0] ?? ''
  if (!clean || clean.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(clean)) return []
  const segments = clean.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')
  if (segments.length === 0 || segments.some((s) => s === '..' || IGNORED_DIRS.has(s.toLowerCase()))) return []
  const path = segments.join('/')
  const out = new Set<string>()
  const htmlDir = posix.dirname(htmlRel)
  if (!clean.startsWith('/') && htmlDir !== '.') out.add(`${htmlDir}/${path}`)
  out.add(`public/${path}`)
  out.add(path)
  return [...out]
}

async function findFromHtml(root: string): Promise<ProjectIcon | null> {
  for (const htmlRel of HTML_FILES) {
    let html: string
    try {
      const abs = toAbs(root, htmlRel)
      const info = await stat(abs)
      if (!info.isFile() || info.size > MAX_HTML_BYTES) continue
      html = await readFile(abs, 'utf8')
    } catch {
      continue
    }
    for (const href of iconHrefs(html)) {
      for (const rel of resolveHref(href, htmlRel)) {
        const icon = await loadIcon(root, rel)
        if (icon) return icon
      }
    }
  }
  return null
}

async function findAtRoot(root: string): Promise<{ icon: ProjectIcon; rank: number } | null> {
  const known = await findKnown(root)
  if (known) return known
  const fromHtml = await findFromHtml(root)
  return fromHtml ? { icon: fromHtml, rank: CANDIDATES.length } : null
}

async function childDirs(root: string, rel: string): Promise<string[]> {
  try {
    const entries = await readdir(rel ? toAbs(root, rel) : root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name.toLowerCase()))
      .map((e) => (rel ? `${rel}/${e.name}` : e.name))
      .sort()
  } catch {
    return []
  }
}

// Monorepo (apps/web, ou pastas irmãs como loja/loja-app): um nível só, e vence o candidato de maior prioridade.
async function findInChildren(root: string): Promise<ProjectIcon | null> {
  const dirs = [
    ...(await childDirs(root, 'apps')),
    ...(await childDirs(root, 'packages')),
    ...(await childDirs(root, ''))
  ]
    .filter((d, i, all) => all.indexOf(d) === i)
    .slice(0, MAX_CHILD_DIRS)
  const found = await Promise.all(dirs.map((d) => findAtRoot(toAbs(root, d))))
  let best: { icon: ProjectIcon; rank: number; dir: string } | null = null
  for (const [i, hit] of found.entries()) {
    const dir = dirs[i]
    if (hit && dir !== undefined && (!best || hit.rank < best.rank)) best = { ...hit, dir }
  }
  return best ? { dataUrl: best.icon.dataUrl, source: `${best.dir}/${best.icon.source}` } : null
}

export async function findProjectIcon(root: string): Promise<ProjectIcon | null> {
  const atRoot = await findAtRoot(root)
  if (atRoot) return atRoot.icon
  return findInChildren(root)
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

export function parseGithubOwner(remote: string): string | null {
  const url = remote.trim()
  let host: string
  let path: string
  if (url.includes('://')) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(parsed.protocol)) return null
    host = parsed.hostname
    path = parsed.pathname
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(url)
    if (!scp) return null
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  }
  if (!GITHUB_HOSTS.has(host.toLowerCase())) return null
  const [owner, repo] = path.replace(/^\/+/, '').split('/')
  if (!owner || !repo || !GITHUB_OWNER.test(owner)) return null
  return owner
}

const execFileAsync = promisify(execFile)

export async function githubAvatarUrl(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: root,
      timeout: 5000,
      windowsHide: true
    })
    const owner = parseGithubOwner(stdout)
    return owner ? `https://github.com/${owner}.png?size=64` : null
  } catch {
    return null
  }
}
