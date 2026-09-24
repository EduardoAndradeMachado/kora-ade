// 'disabled': fora do app instalado (desenvolvimento, testes) não há de onde atualizar.
export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'current'; checkedAt: number }
  | { state: 'error'; message: string }
