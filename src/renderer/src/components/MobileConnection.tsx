import { useEffect, useRef, useState } from 'react'
import type { MobileDevice, MobilePairing, MobileStatus } from '@shared/mobile'
import { Button } from '@/brand/Button'
import { Icon } from '@/brand/icons'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { Toggle } from './Toggle'
import { RemoteConnection } from './RemoteConnection'

type Invite = { pairing: MobilePairing; known: Set<string> }

const countdown = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function MobileConnection(): React.JSX.Element {
  const [status, setStatus] = useState<MobileStatus | null>(null)
  const [invite, setInvite] = useState<Invite | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inviteRef = useRef(invite)
  inviteRef.current = invite

  useEffect(() => {
    const apply = (next: MobileStatus): void => {
      setStatus(next)
      const pending = inviteRef.current
      const paired = pending && next.devices.find((device) => !pending.known.has(device.id))
      if (paired) {
        setInvite(null)
        setConnected(paired.name)
      }
      if (!next.enabled) setInvite(null)
    }
    void window.kora.mobileStatus().then(apply, (error) => setError(ipcErrorMessage(error)))
    return window.kora.onMobileStatus(apply)
  }, [])
  useEffect(() => {
    if (!invite) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [invite])
  useEffect(() => {
    if (!connected) return
    const timer = setTimeout(() => setConnected(null), 8000)
    return () => clearTimeout(timer)
  }, [connected])

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try { await task() } catch (error) { setError(ipcErrorMessage(error)) } finally { setBusy(false) }
  }
  const newConnection = (): Promise<void> => run(async () => {
    const known = new Set(status?.devices.map((device) => device.id))
    const pairing = await window.kora.pairMobile()
    setConnected(null)
    setNow(Date.now())
    setInvite({ pairing, known })
  })
  const expired = invite !== null && now >= Date.parse(invite.pairing.expiresAt)
  const devices = status?.devices ?? []

  return <section className="flex flex-col gap-3 border-t px-4 py-3.5">
    <h3 className="text-xs font-semibold">Celular</h3>
    <Toggle
      checked={status?.enabled ?? false}
      label="Conexão com o celular"
      detail="Use as sessões deste PC no celular, pela mesma rede Wi-Fi ou, fora de casa, pelo Tailscale. Fica ligada até você desligar."
      onChange={(enabled) => { if (status && !busy) void run(async () => setStatus(await window.kora.setMobileEnabled(enabled))) }}
    />
    {status?.enabled && <>
      {!status.network && <p className="text-xs text-muted-foreground">Conecte o PC ao Wi-Fi ou ao cabo de rede para usar o celular.</p>}
      {connected && <p role="status" className="flex items-center gap-2 rounded-lg border border-[var(--brand-amber)] px-3 py-2 text-xs">
        <Icon name="ok" active /><span className="min-w-0 truncate"><strong>{connected}</strong> conectado.</span>
      </p>}
      {devices.length > 0 && <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">Celulares vinculados</span>
        {devices.map((device) => <DeviceRow key={device.id} device={device} busy={busy}
          onRename={(name) => run(async () => setStatus(await window.kora.renameMobile(device.id, name)))}
          onRevoke={() => void run(async () => setStatus(await window.kora.revokeMobile(device.id)))} />)}
      </div>}
      {invite && !expired ? <div className="flex flex-col items-center gap-2 rounded-lg border p-3">
        <img src={invite.pairing.qr} alt="QR code da nova conexão" width="200" height="200" className="max-w-full rounded bg-white" />
        <p className="text-center text-xs leading-snug">No celular, abra o app Kora e toque em <strong>Ler QR code do PC</strong>, ou leia com a câmera.</p>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span role="timer" className="tabular-nums">Expira em {countdown(Date.parse(invite.pairing.expiresAt) - now)}</span>
          <button type="button" className="underline hover:text-foreground" onClick={() => setInvite(null)}>Cancelar</button>
        </div>
      </div> : invite && expired ? <div className="flex flex-col items-start gap-2 rounded-lg border p-3">
        <p className="text-xs text-muted-foreground">O QR code expirou sem nenhum celular conectar.</p>
        <Button disabled={busy} onClick={() => void newConnection()}>Gerar outro</Button>
      </div> : status.network && <Button className="self-start" disabled={busy} onClick={() => void newConnection()}><Icon name="novaAba" />Nova conexão</Button>}
    </>}
    <RemoteConnection status={status} onStatus={setStatus} />
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>
}

function DeviceRow({ device, busy, onRename, onRevoke }: {
  device: MobileDevice
  busy: boolean
  onRename(name: string): Promise<void>
  onRevoke(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const save = (): void => {
    const name = draft?.trim()
    setDraft(null)
    if (name && name !== device.name) void onRename(name)
  }
  return <div className="group flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-secondary/60">
    <span aria-hidden className={cn('size-2 shrink-0 rounded-full', device.online ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
    {draft !== null ? <input
      autoFocus
      aria-label="Nome do celular"
      maxLength={60}
      value={draft}
      className="min-w-0 flex-1 rounded border bg-card px-1.5 py-0.5 text-xs"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') save()
        if (event.key === 'Escape') setDraft(null)
      }}
    /> : <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{device.name}</span>
      <span className="text-[11px] text-muted-foreground">{device.online ? 'Conectado agora' : 'Desconectado'}</span>
    </span>}
    {draft === null && <>
      <button type="button" aria-label={`Renomear ${device.name}`} data-tip="Renomear" disabled={busy} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => setDraft(device.name)}><Icon name="editar" className="size-3.5" /></button>
      <button type="button" aria-label={`Desvincular ${device.name}`} data-tip="Desvincular" disabled={busy} className="shrink-0 rounded p-1 hover:bg-secondary" onClick={onRevoke}><Icon name="excluir" className="size-3.5" /></button>
    </>}
  </div>
}
