import type { KoraApi } from '../shared/ipc'

declare global {
  interface Window {
    kora: KoraApi
  }
}
