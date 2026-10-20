// O PowerShell e o cmd publicam o caminho do próprio executável como título; isso não identifica a aba.
const SHELL_EXE = /(^|[\\/])(powershell|pwsh|cmd|conhost)(\.exe)?$/i
// O OpenCode publica "OC | <título da conversa>" (ou só "OpenCode" antes da primeira mensagem).
const OPENCODE_PREFIX = /^OC\s*\|\s*/i

export function meaningfulTitle(raw: string): string | null {
  const title = raw.trim().replace(OPENCODE_PREFIX, '').trim()
  if (!title || SHELL_EXE.test(title) || /^opencode$/i.test(title)) return null
  return title
}
