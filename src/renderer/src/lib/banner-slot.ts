import { createContext } from 'react'

// O Markdown em Visualizar mostra o texto do editor escondido: as faixas do editor (conflito com o disco, arquivo
// apagado, desfazer de mudança externa) precisam aparecer na visualização, senão a pessoa salva sem ver o aviso.
// `reveal` leva para onde o editor aparece, para o "Comparar".
export interface BannerSlotValue {
  slot: HTMLElement | null
  reveal(): void
}

export const BannerSlot = createContext<BannerSlotValue | null>(null)
