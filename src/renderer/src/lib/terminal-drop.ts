// Caminhos absolutos dos itens arrastados da árvore, em JSON. O text/plain do mesmo arrasto já vem montado para
// outros programas e não serve para o terminal remontar a lista.
export const PATHS_MIME = 'application/x-kora-paths'

// Arrasto sem a lista (outra janela do Kora numa versão antiga) leva só o caminho do text/plain.
export function treeDragPaths(pathsJson: string, plain: string): string[] {
  try {
    const list: unknown = JSON.parse(pathsJson || 'null')
    if (Array.isArray(list) && list.length && list.every((p) => typeof p === 'string')) return list as string[]
  } catch {
    // JSON quebrado: vale o text/plain.
  }
  return plain ? [plain] : []
}

// Como o VS Code ao soltar arquivos no terminal do Windows: cada caminho entre aspas só se tiver espaço, separados por
// espaço. O espaço do fim deixa o cursor pronto para o próximo argumento.
export function terminalDropText(paths: string[]): string {
  const parts = paths.filter(Boolean).map((path) => (/\s/.test(path) ? `"${path}"` : path))
  return parts.length ? `${parts.join(' ')} ` : ''
}
