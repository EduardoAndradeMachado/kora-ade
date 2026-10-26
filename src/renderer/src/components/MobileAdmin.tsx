import { useCallback, useEffect, useState } from 'react'
import type { AdminAccount, AdminDevice, AdminOverview } from '@shared/mobile'
import { Button } from '@/brand/Button'
import { Icon } from '@/brand/icons'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'

const bytes = (value: string | number): string => {
  const n = Number(value)
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = n / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toFixed(size < 10 ? 1 : 0).replace('.', ',')} ${units[unit]}`
}

const ago = (iso: string | null): string => {
  if (!iso) return 'nunca'
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `há ${hours} h`
  return `há ${Math.round(hours / 24)} dias`
}

const hours = (seconds: string): string => {
  const total = Number(seconds)
  return total < 3600 ? `${Math.round(total / 60)} min` : `${(total / 3600).toFixed(total < 36_000 ? 1 : 0).replace('.', ',')} h`
}

// O painel do dono do servidor: quem tem conta, que aparelhos cada uma tem, quanto cada um trafega e quem está no ar.
// Só a conta marcada como admin no banco do relay chega aqui; o relay confere de novo a cada pedido.
export function MobileAdmin({ onBack, onClose }: { onBack(): void; onClose(): void }): React.JSX.Element {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Conta com a confirmação de bloqueio aberta (o Electron não tem window.prompt).
  const [confirming, setConfirming] = useState<{ id: string; reason: string } | null>(null)
  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try { setData(await window.kora.mobileAdmin({ op: 'admin:visao' }) as AdminOverview) } catch (failure) { setError(ipcErrorMessage(failure)) } finally { setBusy(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const block = async (account: AdminAccount, reason = ''): Promise<void> => {
    const blocking = account.blocked_at === null
    setConfirming(null)
    setBusy(true)
    try {
      await window.kora.mobileAdmin(blocking ? { op: 'admin:bloquear', conta: account.id, ...(reason.trim() ? { motivo: reason.trim() } : {}) } : { op: 'admin:desbloquear', conta: account.id })
      await load()
    } catch (failure) {
      setError(ipcErrorMessage(failure))
      setBusy(false)
    }
  }

  const devices = data?.devices ?? []
  const renderAccount = (account: AdminAccount): React.JSX.Element => {
          const mine = devices.filter((device) => device.account_id === account.id)
          return <section key={account.id} aria-label={account.email} className={cn('flex flex-col rounded-lg border', account.blocked_at && 'border-destructive/50')}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs">
              {account.id === data?.you && <span className="text-[11px] font-semibold text-[var(--brand-amber)]">Sua conta</span>}
              <span className="min-w-0 truncate font-medium">{account.email}</span>
              {account.admin && <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">admin</span>}
              {!account.verified_at && <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">sem verificar</span>}
              {account.blocked_at && <span className="rounded-full border border-destructive/60 px-2 py-0.5 text-[10px] text-destructive" data-tip={account.blocked_reason ?? undefined}>bloqueada {ago(account.blocked_at)}</span>}
              <span className="text-[11px] text-muted-foreground">criada {ago(account.created_at)} · último login {ago(account.last_login_at)}</span>
              {!account.admin && confirming?.id !== account.id && <Button variant="secondary" className="ml-auto px-2.5 py-1" disabled={busy}
                onClick={() => (account.blocked_at ? void block(account) : setConfirming({ id: account.id, reason: '' }))}>{account.blocked_at ? 'Desbloquear' : 'Bloquear'}</Button>}
            </div>
            {confirming?.id === account.id && <form aria-label={`Bloquear ${account.email}`} className="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-3 py-2 text-[11px]"
              onSubmit={(event) => { event.preventDefault(); void block(account, confirming.reason) }}>
              <span className="text-muted-foreground">As conexões desta conta caem na hora e ela não entra mais.</span>
              <input autoFocus aria-label="Motivo do bloqueio" placeholder="Motivo (opcional)" maxLength={200} value={confirming.reason}
                onChange={(event) => setConfirming({ id: account.id, reason: event.target.value })} className="min-w-0 flex-1 rounded-md border bg-card px-2 py-1 text-xs" />
              <Button type="submit" variant="danger" className="px-2.5 py-1" disabled={busy}>Confirmar bloqueio</Button>
              <button type="button" className="underline hover:text-foreground" onClick={() => setConfirming(null)}>Cancelar</button>
            </form>}
            {mine.length === 0 ? <p className="px-3 py-2 text-[11px] text-muted-foreground">Nenhum aparelho.</p> : <div className="divide-y">
              {mine.map((device) => <DeviceLine key={device.fingerprint} device={device} pcs={devices} />)}
            </div>}
          </section>
  }
  const online = devices.filter((device) => device.online).length
  const traffic30 = devices.reduce((sum, device) => sum + Number(device.bytes_in_30d) + Number(device.bytes_out_30d), 0)
  return (
    <div role="dialog" aria-modal="true" aria-label="Painel do servidor" onMouseDown={(e) => e.stopPropagation()}
      className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card text-foreground shadow-2xl">
      <div className="flex items-center gap-3 border-b px-5 py-3">
        <button type="button" aria-label="Voltar" data-tip="Voltar" onClick={onBack} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <Icon name="expandir" className="size-3.5 rotate-180" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-sm font-semibold">Painel do servidor</h2>
          <p className="text-[11px] text-muted-foreground">Contas, aparelhos e consumo do Fora de casa. O conteúdo das sessões nunca passa por aqui.</p>
        </div>
        <button type="button" aria-label="Atualizar" data-tip="Atualizar" disabled={busy} onClick={() => void load()} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <Icon name="atualizar" className={cn('size-3.5', busy && 'animate-spin')} />
        </button>
        <button type="button" aria-label="Fechar" data-tip="Fechar" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <Icon name="fechar" className="size-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
        {[['Contas', String(data?.accounts.length ?? '–')], ['Aparelhos', String(devices.length || (data ? 0 : '–'))], ['No ar agora', String(data ? online : '–')], ['Tráfego em 30 dias', data ? bytes(traffic30) : '–']].map(([label, value]) =>
          <div key={label} className="flex flex-col gap-0.5 bg-card px-5 py-3">
            <span className="text-[11px] text-muted-foreground">{label}</span>
            <span className="text-lg font-semibold tabular-nums">{value}</span>
          </div>)}
      </div>

      {error && <p role="alert" className="mx-5 mt-3 text-xs text-destructive">{error}</p>}
      <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
        {data && <>
          {data.accounts.filter((account) => account.id === data.you).map(renderAccount)}
          {data.accounts.length > 1 && <h3 className="mt-2 text-xs font-semibold">Outras contas<span className="ml-1.5 font-normal text-muted-foreground">{data.accounts.length - 1}</span></h3>}
          {data.accounts.filter((account) => account.id !== data.you).map(renderAccount)}
        </>}
        {data && data.accounts.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma conta ainda.</p>}
      </div>
    </div>
  )
}

function DeviceLine({ device, pcs }: { device: AdminDevice; pcs: AdminDevice[] }): React.JSX.Element {
  const linked = device.pcs.map((fingerprint) => pcs.find((pc) => pc.fingerprint === fingerprint)?.name ?? fingerprint.slice(0, 8))
  const system = [device.platform, device.os_version].filter(Boolean).join(' ')
  return <div className="flex flex-col gap-1 px-3 py-2 text-[11px] sm:flex-row sm:items-center sm:gap-4">
    <span className="flex min-w-0 items-center gap-2 sm:w-56">
      <span className="relative shrink-0">
        <Icon name={device.kind === 'pc' ? 'terminal' : 'celular'} className="size-4" />
        <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card', device.online ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium">{device.name ?? (device.kind === 'pc' ? 'PC sem nome' : 'Celular sem nome')}</span>
        <span className="truncate text-muted-foreground">{[system || 'sistema desconhecido', device.app_version].filter(Boolean).join(' · ')}</span>
      </span>
    </span>
    <span className="text-muted-foreground sm:w-40">{device.online ? <span className="text-emerald-600 dark:text-emerald-400">no ar agora</span> : `visto ${ago(device.last_seen_at)}`}{device.last_ip && <> · <code>{device.last_ip}</code></>}</span>
    <span className="tabular-nums text-muted-foreground sm:w-48">30 dias: ↓ {bytes(device.bytes_in_30d)} ↑ {bytes(device.bytes_out_30d)} · {device.sessions_30d} sessões</span>
    <span className="tabular-nums text-muted-foreground">total {bytes(Number(device.bytes_in) + Number(device.bytes_out))}{device.kind === 'pc' && <> · {hours(device.connected_seconds)} no ar</>}</span>
    {device.kind === 'phone' && linked.length > 0 && <span className="truncate text-muted-foreground sm:ml-auto">↔ {linked.join(', ')}</span>}
  </div>
}
