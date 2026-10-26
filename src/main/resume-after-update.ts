import { readFileSync, rmSync, writeFileSync } from 'node:fs'

// O instalador reabre o app logo depois de fechar. Abrir bem mais tarde (instalação que falhou e o app aberto à mão
// no dia seguinte) vale como ligar o PC: as abas ficam suspensas, para continuar quando a pessoa quiser.
export const RESUME_WINDOW_MS = 10 * 60 * 1000

export function rememberLiveTabs(file: string, tabIds: string[], now = Date.now()): void {
  writeFileSync(file, JSON.stringify({ tabIds, at: now }), 'utf8')
}

// Vale uma vez: apagado na leitura, um fechar e abrir comum depois da atualização não reabre nada.
export function takeLiveTabs(file: string, now = Date.now()): string[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    // Logo depois do instalador, antivírus ou indexador podem segurar o arquivo; isso não pode impedir o app de abrir.
    rmSync(file, { force: true })
  } catch {
    return []
  }
  try {
    const saved: unknown = JSON.parse(raw)
    if (typeof saved !== 'object' || saved === null) return []
    const { tabIds, at } = saved as { tabIds?: unknown; at?: unknown }
    if (typeof at !== 'number' || !Array.isArray(tabIds) || now - at > RESUME_WINDOW_MS) return []
    return tabIds.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}
