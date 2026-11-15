// Menor janela em que a interface cabe inteira com as duas laterais abertas (256 + 288 px) e a área central ainda
// mostra cabeçalho, botões e editor sem nada passar por baixo dos painéis. Medido em px da página (zoom 100%).
export const MIN_CONTENT = { width: 960, height: 560 } as const

export interface Area {
  width: number
  height: number
}

// O zoom da interface aumenta tudo em px de tela: com 125% a mesma página precisa de uma janela 25% maior.
// O mínimo nunca passa da área útil do monitor; senão a janela não caberia na tela (zoom alto em notebook).
export function minWindowSize(zoom: number, workArea: Area): Area {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return {
    width: Math.min(Math.round(MIN_CONTENT.width * factor), workArea.width),
    height: Math.min(Math.round(MIN_CONTENT.height * factor), workArea.height)
  }
}
