import { estimatedCost, OPEN_LIMITS, type CostKind } from '../../../shared/open-limits'
import type { FileTab } from './file-tabs'

// Abas de arquivo escondidas ficam montadas (model do Monaco, DOM do Markdown). Sob pressão de memória as mais
// antigas sem alteração não salva são descarregadas, como o navegador faz com abas inativas: o visualizador sai
// da árvore e volta a ler do disco quando a aba aparece de novo.

export interface TabMemoryCandidate {
  id: string
  visible: boolean
  dirty: boolean
  // Última vez que a aba esteve na frente (ms); a menor sai primeiro.
  lastShown: number
  // Estimativa do que a aba ocupa na janela, em bytes.
  cost: number
}

// Nunca a aba na frente nem a que tem alteração não salva (descarregar perderia a edição). Sai a que ficou mais
// tempo escondida até a estimativa liberada cobrir `needBytes`.
export function pickTabsToUnload(candidates: readonly TabMemoryCandidate[], needBytes: number): string[] {
  if (!(needBytes > 0)) return []
  const pool = candidates.filter((c) => !c.visible && !c.dirty && c.cost > 0).sort((a, b) => a.lastShown - b.lastShown)
  const picked: string[] = []
  let freed = 0
  for (const c of pool) {
    if (freed >= needBytes) break
    picked.push(c.id)
    freed += c.cost
  }
  return picked
}

// Quanto uma aba de arquivo pesa, pelo tamanho do arquivo e pelo que ela desenha.
export function tabCost(tab: Pick<FileTab, 'viewer' | 'editing' | 'split' | 'diff' | 'compare'>, bytes: number): number {
  if (tab.diff || tab.compare) return 2 * estimatedCost('text', bytes)
  const kinds: CostKind[] = []
  switch (tab.viewer) {
    case 'markdown': {
      const preview = !tab.editing || tab.split
      if (tab.editing) kinds.push('text')
      // Acima do teto forçado a visualização nem é desenhada.
      if (preview && bytes <= OPEN_LIMITS.forcedMarkdownPreviewBytes) kinds.push('markdown-preview')
      break
    }
    case 'code':
      kinds.push('text')
      break
    case 'sheet':
      kinds.push(tab.editing ? 'text' : 'sheet')
      break
    case 'notebook':
    case 'pdf':
    case 'image':
    case 'media':
      kinds.push(tab.viewer)
      break
    default:
      kinds.push('other')
  }
  return kinds.reduce((sum, kind) => sum + estimatedCost(kind, bytes), 0)
}

export const formatGigabytes = (mb: number): string => `${(Math.round((mb / 1024) * 10) / 10).toString().replace('.', ',')} GB`

export const tightMessage = (usedMB: number): string =>
  `A janela do Kora já está usando ${formatGigabytes(usedMB)} de memória e não há abas inativas para descarregar. ` +
  'Abrir isto pode derrubar a interface: os terminais recomeçam e alterações não salvas se perdem.'

export function pressureNotice(usedMB: number, unloaded: number): string {
  const head = `O Kora está usando muita memória (${formatGigabytes(usedMB)}).`
  if (unloaded === 0) return `${head} Feche abas de arquivo grandes que não está usando para a janela não cair.`
  const tabs = unloaded === 1 ? '1 aba de arquivo inativa foi descarregada e volta' : `${unloaded} abas de arquivo inativas foram descarregadas e voltam`
  return `${head} ${tabs} a carregar do disco quando você abrir.`
}
