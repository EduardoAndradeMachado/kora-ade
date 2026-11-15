import koffi from 'koffi'

// Sem IGNOREUNKNOWN o Windows responde "Selecionar um aplicativo" (OpenWith.exe) para extensão sem programa.
const ASSOCF_INIT_IGNOREUNKNOWN = 0x400
const ASSOCSTR_FRIENDLYAPPNAME = 4
const BUFFER_CHARS = 512
// O usuário pode escolher um programa no "Como deseja abrir?" com o Kora aberto: a resposta não vale para sempre.
const CACHE_MS = 60_000

type AssocQuery = (
  flags: number,
  str: number,
  assoc: string,
  extra: string | null,
  out: Uint16Array,
  length: Uint32Array,
  done: (err: unknown, hr: number) => void
) => void

let query: AssocQuery | undefined
function assocQuery(): AssocQuery {
  if (!query) {
    // O resolvedor do próprio shell: segue UserChoice, HKCR e ProgId de app da Loja (devolve "Fotos", não "AppX4mn…")
    // e descarta UserChoice que aponta para app desinstalado, coisa que ler o registro direto não faz.
    const fn = koffi
      .load('shlwapi.dll')
      .func('int32 __stdcall AssocQueryStringW(uint32 flags, uint32 str, str16 pszAssoc, str16 pszExtra, _Out_ uint16 *pszOut, uint32 *pcchOut)')
    query = fn.async as AssocQuery
  }
  return query
}

// Extensão como o Windows vê: `.env` é a extensão do arquivo `.env`; `Makefile` e `nome.` não têm.
export function windowsExtension(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot < 0 || dot === base.length - 1) return null
  return base.slice(dot).toLowerCase()
}

// `length` volta em caracteres contando o terminador nulo.
export function decodeAssocString(hr: number, out: Uint16Array, length: number): string | null {
  if (hr >>> 0 !== 0) return null
  const chars = Math.max(0, Math.min(length, out.length) - 1)
  const text = Buffer.from(out.buffer, out.byteOffset, chars * 2).toString('utf16le').trim()
  return text || null
}

const cache = new Map<string, { at: number; app: Promise<string | null> }>()

export function defaultAppFor(name: string): Promise<string | null> {
  const ext = windowsExtension(name)
  if (!ext || process.platform !== 'win32') return Promise.resolve(null)
  const hit = cache.get(ext)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.app
  const app = new Promise<string | null>((resolve) => {
    const out = new Uint16Array(BUFFER_CHARS)
    const length = new Uint32Array([BUFFER_CHARS])
    try {
      assocQuery()(ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR_FRIENDLYAPPNAME, ext, null, out, length, (err, hr) =>
        resolve(err ? null : decodeAssocString(hr, out, length[0] ?? 0))
      )
    } catch {
      resolve(null)
    }
  })
  cache.set(ext, { at: Date.now(), app })
  return app
}
