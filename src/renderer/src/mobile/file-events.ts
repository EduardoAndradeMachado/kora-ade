import type { MobileFilesEvent } from '@shared/mobile'

// O aviso de mudança no disco chega pelo fluxo de eventos do MobileApp e vai para a lista de arquivos aberta.
const listeners = new Set<(event: MobileFilesEvent) => void>()

export function publishFiles(event: MobileFilesEvent): void {
  for (const listener of listeners) listener(event)
}

export function onFilesChanged(listener: (event: MobileFilesEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// O PC manda a pasta com \ (caminho do Windows) e a lista do celular pode estar com / (vinda da trilha de pastas).
const key = (dir: string): string => dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function touchesDir(event: MobileFilesEvent, projectId: string, dir: string): boolean {
  return event.projectId === projectId && (event.rescan || event.dirs.some((changed) => key(changed) === key(dir)))
}
