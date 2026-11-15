// O mínimo do buffer do xterm que o recorte usa; o @xterm/xterm e o @xterm/headless têm o mesmo formato.
interface Line { translateToString(trimRight?: boolean): string }
export interface WindowBuffer { cursorY: number; baseY: number; viewportY: number; getLine(y: number): Line | undefined }

// Com o teclado aberto cabem só `fits` das `rows` linhas da tela: devolve a primeira a mostrar (0 = topo da tela).
// A faixa sempre contém o cursor, que é onde o shell espera o comando e onde o Claude e o Codex deixam o campo
// deles, e vai até a última linha escrita abaixo dele (rodapé do agente); o que sobra de espaço mostra o que vem
// acima. Depois de um cls ou numa aba nova, o prompt está no topo e o fim da tela está em branco.
export function firstVisibleRow(buffer: WindowBuffer, rows: number, fits: number): number {
  if (fits >= rows) return 0
  const room = Math.max(1, fits)
  const row = buffer.baseY + buffer.cursorY - buffer.viewportY
  // Rolado para o histórico, o cursor fica abaixo da tela: mostra a parte de baixo do que está sendo lido.
  const cursor = row >= 0 && row < rows ? row : rows - 1
  let last = cursor
  for (let below = rows - 1; below > cursor; below--) {
    if (buffer.getLine(buffer.viewportY + below)?.translateToString(true).trim()) {
      last = below
      break
    }
  }
  const end = Math.min(last, cursor + room - 1)
  return Math.max(0, end - room + 1)
}
