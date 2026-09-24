import { useState } from 'react'
import type { UpdateStatus } from '@shared/update'
import { Button } from '@/brand/Button'

interface Props {
  update: UpdateStatus
  // Devolve false quando não instalou (arquivo não salvo e o usuário desistiu, ou fora do app instalado).
  onInstall(): Promise<boolean>
}

export function UpdateBanner({ update, onInstall }: Props): React.JSX.Element | null {
  const [installing, setInstalling] = useState(false)
  if (update.state !== 'ready') return null
  return (
    <div role="status" className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border bg-card p-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold">Versão {update.version} pronta</span>
        <span className="text-[11px] leading-snug text-muted-foreground">
          Atualizar fecha o Kora como no Sair e abre de novo; as abas voltam com Continuar.
        </span>
      </div>
      <Button
        disabled={installing}
        onClick={() => {
          setInstalling(true)
          void onInstall().then((ok) => !ok && setInstalling(false))
        }}
      >
        {installing ? 'Atualizando…' : 'Atualizar agora'}
      </Button>
    </div>
  )
}
