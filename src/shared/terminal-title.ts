// O PowerShell e o cmd publicam o caminho do próprio executável como título; isso não identifica a aba.
const SHELL_EXE = /(^|[\\/])(powershell|pwsh|cmd|conhost)(\.exe)?$/i

export function meaningfulTitle(raw: string): string | null {
  const title = raw.trim()
  if (!title || SHELL_EXE.test(title)) return null
  return title
}
