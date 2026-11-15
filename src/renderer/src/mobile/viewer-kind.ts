import { viewerFor } from '../../../shared/file-kind'
import { OPEN_LIMITS } from '../../../shared/open-limits'

// O visualizador de cada arquivo no celular. Parte do mesmo viewerFor do PC; o que muda é o que o WebView do Android
// toca e desenha sozinho, e o que vira texto.
export type MobileViewer = 'markdown' | 'html' | 'svg' | 'code' | 'csv' | 'xlsx' | 'notebook' | 'pdf' | 'image' | 'audio' | 'video' | 'external'

// Os de áudio do Chromium que o viewerFor não conhece (lá eles caem em texto).
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/i
const VIDEO = /\.(mp4|m4v|webm|mov)$/i

export function mobileViewerFor(path: string): MobileViewer {
  if (/\.html?$/i.test(path)) return 'html'
  if (AUDIO.test(path)) return 'audio'
  const viewer = viewerFor(path)
  switch (viewer) {
    case 'sheet':
      return /\.xlsx$/i.test(path) ? 'xlsx' : 'csv'
    case 'image':
      return /\.svg$/i.test(path) ? 'svg' : 'image'
    case 'media':
      return VIDEO.test(path) ? 'video' : 'audio'
    default:
      return viewer
  }
}

// Lidos como texto pelo /api/file (com o limite de texto do PC) e com o Editar. O .xlsx e o resto vêm crus.
const TEXTUAL = new Set<MobileViewer>(['markdown', 'html', 'svg', 'code', 'csv', 'notebook'])
export const isTextual = (viewer: MobileViewer): boolean => TEXTUAL.has(viewer)

// Ver é a visualização de cada um (código só leitura, página, imagem, planilha, células); Editar é o texto, e só
// ele abre o teclado.
export const hasEditMode = (path: string): boolean => isTextual(mobileViewerFor(path))

// Com uma linha pedida (o `arquivo:42` tocado no terminal), o que não tem como mostrar a linha na visualização abre
// no texto. Markdown rola até o bloco, a planilha até o registro e o código só leitura até a linha.
export function startsInEdit(viewer: MobileViewer, line: number | null): boolean {
  return line !== null && (viewer === 'html' || viewer === 'svg' || viewer === 'notebook')
}

// Toque simples esconde o cabeçalho e a faixa do arquivo: o que se lê ocupando a tela, sem toque que seja seu.
export const tapsToImmerse = (viewer: MobileViewer): boolean => viewer === 'pdf' || viewer === 'image' || viewer === 'svg'

export type SheetOpen = 'open' | 'ask' | 'too-large'

// Os mesmos degraus do PC (open-limits): acima de sheetBytes pergunta, acima de forcedSheetBytes só baixando.
export function sheetOpenDecision(bytes: number, allowed: boolean): SheetOpen {
  if (bytes > OPEN_LIMITS.forcedSheetBytes) return 'too-large'
  if (bytes > OPEN_LIMITS.sheetBytes) return allowed ? 'open' : 'ask'
  return 'open'
}
