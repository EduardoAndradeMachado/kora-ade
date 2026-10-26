import { useState } from 'react'
import type { MobileStatus } from '@shared/mobile'
import { Button } from '@/brand/Button'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { Toggle } from './Toggle'

const STATE: Record<NonNullable<MobileStatus['remote']>['state'], string> = {
  conectando: 'Conectando ao ponto de encontro…',
  conectado: 'Conectado: o celular alcança este PC de qualquer rede.',
  reconectando: 'Sem conexão com o ponto de encontro. Tentando de novo sozinho…',
  parado: 'Desligado.'
}

// Fora de casa: o PC fica no ponto de encontro (relay) e o celular pareado entra de qualquer rede. O código de convite
// é pedido só na primeira vez; depois fica guardado no PC.
export function RemoteConnection({ status, onStatus }: { status: MobileStatus | null; onStatus(status: MobileStatus): void }): React.JSX.Element {
  const [invite, setInvite] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remote = status?.remote ?? null
  const turn = async (enabled: boolean, code?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onStatus(await window.kora.setMobileRemote(enabled, code))
      setAsking(false)
      setInvite('')
    } catch (failure) {
      const message = ipcErrorMessage(failure)
      if (message.includes('código de convite')) setAsking(true)
      else setError(message)
    } finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-2">
    <Toggle
      checked={remote !== null}
      label="Fora de casa"
      detail="Use este PC pelo celular de qualquer rede, cifrado de ponta a ponta. Enquanto ligado, o PC não suspende sozinho (a tela pode apagar) e o Kora abre com o Windows. Desligar, reiniciar ou suspender pelo menu tiram o PC do ar até alguém entrar nele."
      onChange={(enabled) => { if (!busy) void turn(enabled) }}
    />
    {(asking && remote === null || remote?.error?.includes('código de convite')) && <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (invite.trim()) void turn(true, invite) }}>
      <input type="password" autoFocus value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="Código de convite" aria-label="Código de convite do ponto de encontro" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs" />
      <Button disabled={busy || !invite.trim()}>Ligar</Button>
    </form>}
    {remote && <p role="status" className="text-xs text-muted-foreground">{STATE[remote.state]}{remote.error && remote.state !== 'conectado' ? ` ${remote.error}` : ''}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
