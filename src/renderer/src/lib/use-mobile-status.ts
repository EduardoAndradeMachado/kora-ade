import { useEffect, useState } from 'react'
import type { MobileStatus } from '@shared/mobile'

// O estado da conexão com o celular, atualizado pelo main a cada mudança (pareou, conectou, o relay caiu).
export function useMobileStatus(): [MobileStatus | null, (status: MobileStatus) => void] {
  const [status, setStatus] = useState<MobileStatus | null>(null)
  useEffect(() => {
    void window.kora.mobileStatus().then(setStatus, () => {})
    return window.kora.onMobileStatus(setStatus)
  }, [])
  return [status, setStatus]
}
