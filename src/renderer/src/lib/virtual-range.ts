export interface RowRange {
  start: number
  end: number
}

// Linhas [start, end) de uma lista de altura fixa que aparecem na janela de rolagem, com `overscan` linhas a mais
// de cada lado. `listTop` é onde a lista começa dentro do conteúdo rolável (ela pode estar abaixo de outras seções).
// Com `step`, as pontas andam em blocos (para fora): rolar uma linha não muda a faixa nem renderiza a lista de novo.
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  listTop: number,
  count: number,
  rowHeight: number,
  overscan: number,
  step = 1
): RowRange {
  const first = Math.floor(Math.floor((scrollTop - listTop) / rowHeight - overscan) / step) * step
  const last = Math.ceil(Math.ceil((scrollTop + viewportHeight - listTop) / rowHeight + overscan) / step) * step
  const start = Math.min(Math.max(first, 0), count)
  return { start, end: Math.min(Math.max(last, start), count) }
}
