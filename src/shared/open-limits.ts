// Limites de abertura por visualizador, usados pelo main (leitura) e pelo renderer (o que é desenhado).
// Os números vêm de medição no Kora (Electron 44, Windows, memória privada do processo da janela):
// - texto puro no Monaco: ~5x o arquivo no pico e ~3x aberto (47 MB: +220 MB; 10 abas de 20 MB: +500 MB);
// - TS/JS no worker do TypeScript: 50 a 140x, e o worker não devolve nada ao fechar a aba (20 MB: +1 GB;
//   20 MB minificado: +2 GB; a 6a aba de 20 MB derrubou a janela: os isolates do renderer dividem uns 4 GB);
// - JSON no worker do JSON: ~13x (30 MB: +385 MB);
// - Markdown visualizado: ~450x, quase tudo DOM (1 MB: +650 MB no pico; 4,5 MB: +2,1 GB e 15 s travado);
// - CSV: ~6x (47 MB: +300 MB); .xlsx: ~2,6x o XML descompactado (zip de 1 MB com 250 MB de XML: +650 MB);
// - imagem: largura x altura x 4 decodificada, passageiro (20000x20000: +1,5 GB); acima disso o próprio
//   Chromium recusa decodificar (30000x30000 só mostra o erro), então imagem não ganha teto aqui.

const MB = 1024 * 1024

export const OPEN_LIMITS = {
  // Texto no editor: acima de textBytes pede "Abrir mesmo assim"; acima de forcedTextBytes só o programa padrão.
  textBytes: 5 * MB,
  forcedTextBytes: 50 * MB,
  // Planilha (.csv lido como texto, .xlsx lido em bytes): os mesmos degraus do texto.
  sheetBytes: 5 * MB,
  forcedSheetBytes: 50 * MB,
  // Teto do que o .xlsx pode descompactar no renderer, por parte e somando as partes lidas (folhas abertas,
  // strings compartilhadas, estilos). 256 MB de XML já custam ~650 MB na janela.
  xlsxPartBytes: 256 * MB,
  xlsxTotalBytes: 256 * MB,
  // Até aqui o arquivo entra no worker de linguagem (erros de sintaxe, F12, hover); acima, só o realce de cores.
  // TS/JS com 1 MB: o mesmo teto da navegação entre arquivos (code-nav-core), ~100 MB no worker.
  languageServiceBytes: { typescript: 1 * MB, javascript: 1 * MB, other: 5 * MB },
  // Markdown desenhado (Visualizar e a metade direita do Lado a lado). Acima de markdownPreviewBytes abre em
  // Editar e a visualização pede confirmação; acima de forcedMarkdownPreviewBytes (~1 GB no pico), só Editar.
  markdownPreviewBytes: 1 * MB,
  forcedMarkdownPreviewBytes: 2 * MB
} as const

// Linguagens que o Monaco manda para um worker de análise (o arquivo inteiro é copiado e analisado lá).
const WORKER_LANGUAGES = new Set(['typescript', 'javascript', 'json', 'css', 'scss', 'less', 'html', 'handlebars', 'razor'])

export const LIGHT_LANGUAGE_SUFFIX = '-leve'

// A linguagem do editor para um arquivo de `length` caracteres: acima do teto do worker, a variante "leve"
// (mesmo realce, sem worker). Comprimento em caracteres da string, que é o que vai para o worker.
export function editorLanguageFor(languageId: string | undefined, length: number): string | undefined {
  if (!languageId || !WORKER_LANGUAGES.has(languageId)) return languageId
  const limits = OPEN_LIMITS.languageServiceBytes
  const cap = languageId === 'typescript' ? limits.typescript : languageId === 'javascript' ? limits.javascript : limits.other
  return length > cap ? languageId + LIGHT_LANGUAGE_SUFFIX : languageId
}

export const isWorkerLanguage = (languageId: string): boolean => WORKER_LANGUAGES.has(languageId)

export type MarkdownPreviewDecision = 'render' | 'ask' | 'edit-only'

// allowed: o usuário já escolheu "Visualizar mesmo assim" para este arquivo.
export function markdownPreviewDecision(length: number, allowed: boolean): MarkdownPreviewDecision {
  if (length > OPEN_LIMITS.forcedMarkdownPreviewBytes) return 'edit-only'
  if (length > OPEN_LIMITS.markdownPreviewBytes) return allowed ? 'render' : 'ask'
  return 'render'
}

export type CostKind = 'text' | 'markdown-preview' | 'sheet' | 'notebook' | 'pdf' | 'image' | 'media' | 'other'

// Memória da janela por byte do arquivo, para escolher o que descarregar e estimar o custo de abrir.
// Medida como acima, arredondada para cima. PDF roda em outro processo (o do visualizador do Chromium).
const COST_PER_BYTE: Record<CostKind, number> = {
  text: 6,
  'markdown-preview': 450,
  sheet: 8,
  notebook: 5,
  pdf: 0,
  image: 1,
  media: 0,
  other: 1
}

export const estimatedCost = (kind: CostKind, bytes: number): number => Math.max(0, bytes) * COST_PER_BYTE[kind]

// Pedido do vigia do main: a janela passou do limite e precisa liberar até targetMB.
export interface MemoryPressure {
  usedMB: number
  targetMB: number
}

export interface MemoryUsage {
  usedMB: number
  softMB: number
}

export const formatMegabytes =(bytes: number): string => {
  const mb = bytes / MB
  return `${mb >= 10 ? Math.round(mb) : (Math.round(mb * 10) / 10).toString().replace('.', ',')} MB`
}
