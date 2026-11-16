import { cn } from '@/lib/utils'

// Folha do ícone "arquivo" da identidade (grade de 24, traço 1,75) com um sinal dentro que diz o tipo. Contorno na
// cor do texto e sinal no cinza do detalhe inativo, sem cor por categoria: o tipo se lê pela forma. A cor do git fica
// no nome do arquivo, não no ícone.
const STROKE = 1.75
const PAGE = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'

const GLYPH = {
  texto: <path d="M8.5 13h7M8.5 16.5h4.5" />,
  codigo: <path d="M10 12l-2.2 2.5L10 17M14 12l2.2 2.5L14 17" />,
  html: <path d="M9.5 11.5 7.3 14.5l2.2 3M14.5 11.5l2.2 3-2.2 3M12.8 11l-1.6 7" />,
  dados: (
    <path d="M10 11.5c-1 0-1.5.5-1.5 1.5v.4c0 .7-.4 1.1-1 1.1.6 0 1 .4 1 1.1v.4c0 1 .5 1.5 1.5 1.5M14 11.5c1 0 1.5.5 1.5 1.5v.4c0 .7.4 1.1 1 1.1-.6 0-1 .4-1 1.1v.4c0 1-.5 1.5-1.5 1.5" />
  ),
  markdown: <path d="M7.5 17.5v-5l2.4 2.8 2.4-2.8v5M15.5 12.5v5M14 16l1.5 1.5L17 16" />,
  imagem: (
    <>
      <circle cx="9.5" cy="11.5" r="1.4" fill="currentColor" />
      <path d="M5.5 18l3.5-3.5 2.5 2.5 3-3 4 4" />
    </>
  ),
  pdf: <rect x="7.5" y="12.5" width="9" height="5" rx="1.2" fill="currentColor" fillOpacity={0.35} />,
  video: <path d="M10 11.5v6l5-3z" fill="currentColor" />,
  audio: (
    <>
      <circle cx="9" cy="17" r="1.5" />
      <circle cx="14.5" cy="15.5" r="1.5" />
      <path d="M10.5 17v-5.5L16 10v5.5" />
    </>
  ),
  planilha: (
    <>
      <rect x="8" y="11.5" width="8" height="6.5" rx="0.8" />
      <path d="M8 14.75h8M11.5 11.5V18" />
    </>
  ),
  documento: <path d="M8.5 12h7M8.5 15h7M8.5 18h4.5" />,
  apresentacao: (
    <>
      <rect x="7.5" y="11" width="9" height="5.5" rx="0.8" />
      <path d="M12 16.5V19" />
    </>
  ),
  compactado: (
    <>
      <path d="M11 3.5h1.5M11 6.5h1.5M11 9.5h1.5" />
      <rect x="10" y="12.5" width="3.5" height="5" rx="1" />
    </>
  ),
  config: (
    <>
      <path d="M8 12.5h8M8 16.5h8" />
      <circle cx="10.5" cy="12.5" r="1.3" fill="currentColor" />
      <circle cx="13.5" cy="16.5" r="1.3" fill="currentColor" />
    </>
  ),
  segredo: (
    <>
      <circle cx="9.5" cy="15" r="2" />
      <path d="M11.5 15h5M15 15v2M16.5 15v1.5" />
    </>
  ),
  terminal: <path d="M8 12l2.5 2.5L8 17M12 17.5h4" />,
  estilo: <path d="M10.3 11.5l-1 7M14.3 11.5l-1 7M8 13.8h7.8M7.6 16.4h7.8" />,
  fonte: <path d="M8.5 18.5l3.5-8 3.5 8M9.8 15.5h4.4" />,
  banco: (
    <>
      <ellipse cx="12" cy="12" rx="3.5" ry="1.3" />
      <path d="M8.5 12v5c0 .7 1.6 1.3 3.5 1.3s3.5-.6 3.5-1.3v-5M8.5 14.5c0 .7 1.6 1.3 3.5 1.3s3.5-.6 3.5-1.3" />
    </>
  ),
  binario: (
    <>
      <circle cx="12" cy="14.5" r="2" />
      <path d="M12 10.8v1.2M12 17v1.2M8.3 14.5h1.2M14.5 14.5h1.2" />
    </>
  ),
  trava: (
    <>
      <rect x="9" y="14" width="6" height="4.5" rx="1" />
      <path d="M10.3 14v-1.5a1.7 1.7 0 0 1 3.4 0V14" />
    </>
  ),
  git: (
    <>
      <circle cx="9.5" cy="11.5" r="1.2" />
      <circle cx="9.5" cy="17.5" r="1.2" />
      <circle cx="14.5" cy="13" r="1.2" fill="currentColor" />
      <path d="M9.5 12.7v3.6M14.5 14.2c0 1.8-2.6 1.7-4.2 2.5" />
    </>
  ),
  notebook: (
    <>
      <rect x="8" y="11" width="8" height="3" rx="0.6" />
      <rect x="8" y="15.5" width="8" height="3" rx="0.6" />
    </>
  )
} satisfies Record<string, React.JSX.Element>

type Glyph = keyof typeof GLYPH

const BY_EXT = new Map<string, Glyph>()
const add = (kind: Glyph, exts: string): void => {
  for (const ext of exts.split(' ')) BY_EXT.set(ext, kind)
}
add('codigo', 'ts tsx mts cts c h cpp cc cxx hpp hh lua r js jsx mjs cjs py pyw pyi vue go dart rs swift svelte zig java rb scala erb kt kts cs php ex exs fs vb pl asm')
add('html', 'html htm xhtml')
add('dados', 'json jsonc json5 geojson xml')
add('markdown', 'md markdown mdx')
add('texto', 'txt log rtf')
add('imagem', 'png jpg jpeg gif webp svg ico bmp avif tif tiff heic psd')
add('pdf', 'pdf')
add('video', 'mp4 webm mov mkv avi m4v')
add('audio', 'mp3 wav ogg flac m4a aac opus')
add('planilha', 'xls xlsx xlsm ods csv tsv')
add('documento', 'doc docx odt pages')
add('apresentacao', 'ppt pptx odp')
add('compactado', 'zip 7z rar gz tgz tar bz2 xz zst')
add('config', 'yml yaml toml ini cfg conf config properties editorconfig prettierrc eslintrc npmrc nvmrc babelrc')
add('segredo', 'env pem key crt cer p12 pfx')
add('terminal', 'sh bash zsh fish ps1 psm1 bat cmd')
add('estilo', 'css scss sass less styl')
add('fonte', 'ttf otf woff woff2 eot')
add('banco', 'sqlite sqlite3 db sql')
add('binario', 'exe dll msi bin so dylib wasm class o obj apk')
add('trava', 'lock')
add('notebook', 'ipynb')

const BY_NAME = new Map<string, Glyph>(Object.entries({
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  'package-lock.json': 'trava',
  'pnpm-lock.yaml': 'trava',
  dockerfile: 'config',
  makefile: 'terminal',
  license: 'texto'
} satisfies Record<string, Glyph>))

export function fileKindFor(name: string): Glyph {
  const lower = name.toLowerCase()
  const named = BY_NAME.get(lower)
  if (named) return named
  // .env.local, .env.production: o que vem depois do primeiro ponto não muda o que o arquivo é.
  if (lower === '.env' || lower.startsWith('.env.')) return 'segredo'
  const dot = lower.lastIndexOf('.')
  return (dot >= 0 && BY_EXT.get(lower.slice(dot + 1))) || 'texto'
}

export function FileIcon({ name, className }: { name: string; className?: string }): React.JSX.Element {
  const glyph = fileKindFor(name)
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-file-icon={glyph}
      className={cn('size-4 shrink-0 text-foreground', className)}
    >
      <path d={PAGE} />
      <path d="M14 3v5h5" />
      <g className="text-[var(--icon-accent-idle)]">{GLYPH[glyph]}</g>
    </svg>
  )
}
