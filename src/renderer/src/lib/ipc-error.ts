// O ipcRenderer.invoke embrulha o erro do main em "Error invoking remote method 'canal': Error: ...".
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
  if (message.startsWith('ENOENT')) return 'Esse item não existe mais: foi movido ou apagado fora do Kora.'
  return message
}

export const isNotFound = (err: unknown): boolean => String(err instanceof Error ? err.message : err).includes('ENOENT')
