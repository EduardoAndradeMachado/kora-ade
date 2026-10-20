interface ScreenBuffer {
  length: number
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
}

// Só o texto visível, sem modos nem buffer alternativo: escrito de volta num terminal novo, o que veio
// antes vira histórico acima do shell atual, em vez de deixar o terminal preso na tela do agente.
export function screenText(buffer: ScreenBuffer): string {
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
