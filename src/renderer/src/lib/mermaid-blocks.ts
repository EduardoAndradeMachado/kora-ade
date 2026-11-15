// O mermaid pesa alguns MB: só é baixado quando um documento tem um bloco ```mermaid.
type Mermaid = (typeof import('mermaid'))['default']

let loading: Promise<Mermaid> | null = null
let configuredDark: boolean | null = null
let counter = 0

const CACHE_LIMIT = 64
const cache = new Map<string, string>()

const cacheKey = (dark: boolean, code: string): string => `${dark ? 'd' : 'l'}\n${code}`

function remember(key: string, svg: string): void {
  cache.delete(key)
  cache.set(key, svg)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}

async function load(dark: boolean): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default)
  const mermaid = await loading
  if (configuredDark !== dark) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default' })
    configuredDark = dark
  }
  return mermaid
}

function clearOutput(pre: HTMLElement): void {
  const before = pre.previousElementSibling
  if (before?.matches('.mermaid-diagram, .mermaid-error')) before.remove()
}

function showDiagram(pre: HTMLElement, svg: string, stale: boolean): void {
  clearOutput(pre)
  const box = document.createElement('div')
  box.className = 'mermaid-diagram'
  if (stale) box.dataset['stale'] = ''
  box.innerHTML = svg
  pre.hidden = true
  pre.before(box)
}

function showError(pre: HTMLElement, message: string): void {
  clearOutput(pre)
  const note = document.createElement('p')
  note.className = 'mermaid-error'
  note.textContent = `Diagrama com erro: ${message}`
  pre.hidden = false
  pre.before(note)
}

// `previous` guarda o último desenho de cada bloco pela posição: enquanto o texto muda no lado a lado, o diagrama
// antigo fica na tela (esmaecido) em vez de piscar o código a cada tecla. Quem chama passa um mapa por documento.
export async function renderMermaidBlocks(
  root: HTMLElement,
  dark: boolean,
  previous: Map<number, string>,
  isCurrent: () => boolean
): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre[data-mermaid]')]
  const pending: { pre: HTMLElement; index: number; code: string }[] = []
  blocks.forEach((pre, index) => {
    const code = pre.textContent ?? ''
    const cached = cache.get(cacheKey(dark, code))
    if (cached) {
      showDiagram(pre, cached, false)
      previous.set(index, cached)
      return
    }
    const last = previous.get(index)
    if (last) showDiagram(pre, last, true)
    pending.push({ pre, index, code })
  })
  if (pending.length === 0) return

  let mermaid: Mermaid
  try {
    mermaid = await load(dark)
  } catch (err) {
    if (!isCurrent()) return
    for (const { pre } of pending) showError(pre, `não foi possível carregar o mermaid (${err instanceof Error ? err.message : String(err)})`)
    return
  }
  for (const { pre, index, code } of pending) {
    // A configuração do mermaid é global: se o tema mudou no meio, quem continua é a renderização do tema novo.
    if (!isCurrent() || configuredDark !== dark) return
    const id = `kora-mermaid-${++counter}`
    try {
      const { svg } = await mermaid.render(id, code)
      remember(cacheKey(dark, code), svg)
      if (!isCurrent()) return
      showDiagram(pre, svg, false)
      previous.set(index, svg)
    } catch (err) {
      // Num erro o mermaid pode deixar o rascunho do desenho solto no body.
      document.getElementById(`d${id}`)?.remove()
      if (!isCurrent()) return
      previous.delete(index)
      showError(pre, err instanceof Error ? err.message : String(err))
    }
  }
}
