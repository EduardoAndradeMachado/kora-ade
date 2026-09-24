import { useEffect, useState } from 'react'
import { Button } from '@/brand/Button'

export function UpdateBanner(): React.JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    void window.kora.pendingUpdate().then((v) => v && setVersion(v))
    return window.kora.onUpdateReady(setVersion)
  }, [])

  if (!version) return null
  return (
    <div role="status" className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border bg-card p-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold">Versão {version} pronta</span>
        <span className="text-[11px] leading-snug text-muted-foreground">
          Atualizar fecha o Kora como no Sair e abre de novo; as abas voltam com Continuar.
        </span>
      </div>
      <Button
        disabled={installing}
        onClick={() => {
          setInstalling(true)
          void window.kora.installUpdate().then((ok) => !ok && setInstalling(false))
        }}
      >
        {installing ? 'Atualizando…' : 'Atualizar agora'}
      </Button>
    </div>
  )
}
