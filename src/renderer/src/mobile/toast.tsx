import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'

// Aviso curto que sobrevive à folha que o pediu: a folha fecha na hora e o aviso fica alguns segundos por cima da tela.
const listeners = new Set<(text: string) => void>()
const TOAST_MS = 2600

export function showToast(text: string): void {
  for (const listener of listeners) listener(text)
}

export function Toaster(): React.JSX.Element | null {
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (text: string): void => {
      clearTimeout(timer)
      setToast((previous) => ({ text, id: (previous?.id ?? 0) + 1 }))
      timer = setTimeout(() => setToast(null), TOAST_MS)
    }
    listeners.add(show)
    return () => { listeners.delete(show); clearTimeout(timer) }
  }, [])
  if (!toast) return null
  return <div key={toast.id} role="status" className="mobile-toast"><Icon name="ok" active />{toast.text}</div>
}
