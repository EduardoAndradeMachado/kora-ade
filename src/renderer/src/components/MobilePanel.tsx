import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountAction, MobileDevice, MobilePairing, MobileStatus } from '@shared/mobile'
import { Button } from '@/brand/Button'
import { Icon } from '@/brand/icons'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { useMobileStatus } from '@/lib/use-mobile-status'
import { useWindowDim } from '@/lib/use-window-dim'
import { cn } from '@/lib/utils'
import { MobileAdmin } from './MobileAdmin'
import { Toggle } from './Toggle'

type Invite = { pairing: MobilePairing; known: Set<string> }

const countdown = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const REMOTE_STATE: Record<NonNullable<MobileStatus['remote']>['state'], { text: string; tone: 'ok' | 'wait' | 'off' }> = {
  conectando: { text: 'Conectando ao servidor do Kora…', tone: 'wait' },
  conectado: { text: 'No ar: o celular alcança este PC de qualquer rede.', tone: 'ok' },
  reconectando: { text: 'Sem conexão com o servidor do Kora. Tentando de novo sozinho…', tone: 'wait' },
  parado: { text: 'Desligado.', tone: 'off' }
}

function Dot({ tone }: { tone: 'ok' | 'wait' | 'off' }): React.JSX.Element {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', tone === 'ok' ? 'bg-emerald-500' : tone === 'wait' ? 'bg-[var(--brand-amber)]' : 'bg-muted-foreground/40')} />
}

// Celular: tudo o que liga o app Kora do celular a este PC, num lugar só. Os caminhos (rede de casa e fora de casa),
// os celulares vinculados e a conexão de um celular novo.
export function MobileDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  useWindowDim()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-[1px]" onMouseDown={onClose}>
      <MobilePanel onClose={onClose} />
    </div>,
    document.body
  )
}

export function MobilePanel({ onClose }: { onClose(): void }): React.JSX.Element {
  const [status, setStatus] = useMobileStatus()
  const [invite, setInvite] = useState<Invite | null>(null)
  const [connected, setConnected] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [admin, setAdmin] = useState(false)
  const inviteRef = useRef(invite)
  inviteRef.current = invite

  // Celular novo na lista enquanto o QR estava na tela: foi ele que acabou de parear.
  useEffect(() => {
    const pending = inviteRef.current
    const paired = pending && status?.devices.find((device) => !pending.known.has(device.id))
    if (paired) {
      setInvite(null)
      setConnected(paired.name)
    }
    if (status && !status.enabled && !status.remote) setInvite(null)
  }, [status])
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
    try { await task() } catch (failure) { setError(ipcErrorMessage(failure)) } finally { setBusy(false) }
  }
  const connect = (): Promise<void> => run(async () => {
    const known = new Set(status?.devices.map((device) => device.id))
    const pairing = await window.kora.pairMobile()
    setConnected(null)
    setNow(Date.now())
    setInvite({ pairing, known })
  })
  const expired = invite !== null && now >= Date.parse(invite.pairing.expiresAt)
  const devices = status?.devices ?? []
  const reachable = Boolean(status?.enabled || status?.remote)

  if (admin && status?.account?.admin) return <MobileAdmin onBack={() => setAdmin(false)} onClose={onClose} />

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Celular"
      onMouseDown={(e) => e.stopPropagation()}
      className="flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-xl border bg-card text-foreground shadow-2xl"
    >
      <div className="flex items-center gap-3 border-b px-5 py-3">
        <Icon name="celular" className="size-5" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-sm font-semibold">Celular</h2>
          <p className="text-[11px] text-muted-foreground">Use as sessões, os terminais e os arquivos deste PC pelo app Kora do celular.</p>
        </div>
        <button autoFocus type="button" data-tip="Fechar" aria-label="Fechar" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <Icon name="fechar" className="size-3.5" />
        </button>
      </div>

      {invite && !expired && <PairingCard invite={invite.pairing} now={now} onCancel={() => setInvite(null)} />}
      {invite && expired && <div className="mx-5 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-xs">
        <span className="text-muted-foreground">O QR expirou sem nenhum celular conectar.</span>
        <Button disabled={busy} onClick={() => void connect()}>Gerar outro</Button>
      </div>}
      {connected && <p role="status" className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-[var(--brand-amber)] px-3 py-2 text-xs">
        <Icon name="ok" active /><span className="min-w-0 truncate"><strong>{connected}</strong> conectado.</span>
      </p>}

      <section className="flex flex-col gap-3 px-5 py-4">
        <h3 className="text-xs font-semibold">Caminhos até este PC</h3>
        <div className="flex flex-col gap-3">
          <HomeRoute status={status} busy={busy} onTurn={(enabled) => run(async () => setStatus(await window.kora.setMobileEnabled(enabled)))} />
          <AwayRoute status={status} busy={busy}
            onTurn={(enabled) => run(async () => setStatus(await window.kora.setMobileRemote(enabled)))}
            onAccount={async (action) => { setBusy(true); try { setStatus(await window.kora.mobileAccount(action)) } finally { setBusy(false) } }}
            onSignOut={() => run(async () => setStatus(await window.kora.signOutMobile()))}
            onAdmin={() => setAdmin(true)} />
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">Celulares vinculados{devices.length > 0 && <span className="ml-1.5 font-normal text-muted-foreground">{devices.length}</span>}</h3>
          {!invite && <Button disabled={busy || !reachable} title={reachable ? undefined : 'Ligue um dos caminhos acima antes'} onClick={() => void connect()}><Icon name="novaAba" />Conectar celular</Button>}
        </div>
        {devices.length === 0 ? <div className="flex flex-col gap-1 rounded-lg border border-dashed px-4 py-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Nenhum celular ainda</span>
          <span>Ligue um caminho acima e toque em <strong className="text-foreground">Conectar celular</strong>. No celular, o app Kora lê o QR e pronto, uma vez só.</span>
        </div> : <div className="flex flex-col divide-y rounded-lg border">
          {devices.map((device) => <DeviceRow key={device.id} device={device} busy={busy} away={Boolean(status?.remote || status?.account)}
            onRename={(name) => run(async () => setStatus(await window.kora.renameMobile(device.id, name)))}
            onRevoke={() => void run(async () => setStatus(await window.kora.revokeMobile(device.id)))} />)}
        </div>}
      </section>

      {error && <p role="alert" className="mx-5 mb-4 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function RouteCard({ detail, checked, label, onToggle, children }: { detail: string; checked: boolean; label: string; onToggle(enabled: boolean): void; children?: React.ReactNode }): React.JSX.Element {
  return <div className={cn('flex flex-col gap-2 rounded-lg border p-3', checked && 'border-[var(--brand-amber)]/50')}>
    <Toggle checked={checked} label={label} detail={detail} onChange={onToggle} />
    {children && <div className="flex flex-col gap-1.5 pl-10 text-[11px] text-muted-foreground">{children}</div>}
  </div>
}

function HomeRoute({ status, busy, onTurn }: { status: MobileStatus | null; busy: boolean; onTurn(enabled: boolean): void }): React.JSX.Element {
  const on = status?.enabled ?? false
  return <RouteCard label="Rede de casa" detail="O celular no mesmo Wi-Fi deste PC." checked={on} onToggle={(enabled) => { if (status && !busy) onTurn(enabled) }}>
    {on && (status?.address
      ? <span className="flex flex-wrap items-center gap-x-1.5"><Dot tone="ok" />Neste Wi-Fi em <code className="text-foreground">{status.address}</code></span>
      : <span className="flex items-center gap-1.5"><Dot tone="wait" />Conecte o PC ao Wi-Fi ou ao cabo de rede.</span>)}
  </RouteCard>
}

function AwayRoute({ status, busy, onTurn, onAccount, onSignOut, onAdmin }: {
  status: MobileStatus | null
  busy: boolean
  onTurn(enabled: boolean): void
  onAccount(action: AccountAction): Promise<void>
  onSignOut(): void
  onAdmin(): void
}): React.JSX.Element {
  const remote = status?.remote ?? null
  const account = status?.account ?? null
  // Ligar sem conta não liga: o aviso aparece e o formulário de entrar abre logo abaixo.
  const [needsAccount, setNeedsAccount] = useState(false)
  const state = remote ? REMOTE_STATE[remote.state] : null
  const refused = remote?.error?.includes('conta ativa') ?? false
  return <RouteCard label="Fora de casa" detail="De qualquer rede, cifrado de ponta a ponta pelo servidor do Kora." checked={remote !== null}
    onToggle={(enabled) => {
      if (busy) return
      if (account || !enabled) return onTurn(enabled)
      setNeedsAccount(true)
    }}>
    {!account && needsAccount && <span role="alert" className="flex items-center gap-1.5 text-[var(--brand-amber)]"><Icon name="cadeado" active className="size-3" />Entre na sua conta do Kora para ligar o acesso fora de casa.</span>}
    {state && <span className="flex items-center gap-1.5"><Dot tone={refused ? 'wait' : state.tone} />{refused ? remote!.error : state.text}</span>}
    {account
      ? <span className="flex flex-wrap items-center gap-x-1.5">Conta <span className="text-foreground">{account.email}</span>·<button type="button" className="underline hover:text-foreground" disabled={busy} onClick={onSignOut}>Sair</button></span>
      : <AccountForm busy={busy} onSubmit={onAccount} />}
    {account?.admin && <button type="button" className="flex items-center gap-1.5 self-start underline hover:text-foreground" onClick={onAdmin}><Icon name="engrenagem" className="size-3" />Painel do servidor</button>}
    {remote && <span>Enquanto ligado, o PC não suspende sozinho (a tela pode apagar) e o Kora abre com o Windows. Desligar, reiniciar ou suspender pelo menu tiram o PC do ar.</span>}
  </RouteCard>
}

type AccountStep = 'entrar' | 'cadastro' | 'codigo-cadastro' | 'esqueci' | 'codigo-esqueci'

// Entrar, criar conta ou trocar a senha, dentro do próprio cartão. O código chega por e-mail e é digitado aqui; a senha
// só é escolhida junto com o código, por quem recebeu o e-mail.
function AccountForm({ busy, onSubmit }: { busy: boolean; onSubmit(action: AccountAction): Promise<void> }): React.JSX.Element {
  const [step, setStep] = useState<AccountStep>('entrar')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const go = (next: AccountStep): void => { setStep(next); setError(null); setNotice(null); setPassword(''); setCode('') }
  const send = async (action: AccountAction, after?: AccountStep): Promise<void> => {
    setError(null)
    try {
      await onSubmit(action)
      if (after) {
        setStep(after)
        setNotice(`Se ${email.trim().toLowerCase()} puder receber, um código acabou de chegar lá. Confira também o spam.`)
      }
    } catch (failure) {
      setError(ipcErrorMessage(failure))
    }
  }
  const submit = (): void => {
    if (busy) return
    if (step === 'entrar') void send({ acao: 'entrar', email, senha: password })
    if (step === 'cadastro') void send({ acao: 'cadastro', email }, 'codigo-cadastro')
    if (step === 'esqueci') void send({ acao: 'esqueci', email }, 'codigo-esqueci')
    if (step === 'codigo-cadastro') void send({ acao: 'verificar', email, codigo: code, senha: password })
    if (step === 'codigo-esqueci') void send({ acao: 'redefinir', email, codigo: code, senha: password })
  }
  const withCode = step === 'codigo-cadastro' || step === 'codigo-esqueci'
  const input = 'w-full min-w-0 rounded-md border bg-transparent px-2 py-1 text-xs text-foreground'
  const link = 'font-medium text-[var(--brand-amber)] hover:underline disabled:opacity-50'
  const title = { entrar: 'Entrar na conta do Kora', cadastro: 'Criar conta do Kora', 'codigo-cadastro': 'Confirme o e-mail', esqueci: 'Trocar a senha', 'codigo-esqueci': 'Nova senha' }[step]
  const action = { entrar: 'Entrar e ligar', cadastro: 'Enviar código', 'codigo-cadastro': 'Criar conta e ligar', esqueci: 'Enviar código', 'codigo-esqueci': 'Trocar senha e ligar' }[step]
  return <form aria-label={title} className="flex flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); submit() }}>
    <span className="font-medium text-foreground">{title}</span>
    {notice && <span role="status">{notice}</span>}
    {withCode
      ? <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="Código de 6 números" aria-label="Código do e-mail" className={cn(input, 'tracking-widest')} />
      : <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="seu@email.com" aria-label="E-mail" className={input} />}
    {(step === 'entrar' || withCode) && <input type="password" autoComplete={step === 'entrar' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)}
      placeholder={step === 'entrar' ? 'Senha' : 'Nova senha, 10 caracteres ou mais'} aria-label={step === 'entrar' ? 'Senha' : 'Nova senha'} className={input} />}
    {error && <span role="alert" className="text-destructive">{error}</span>}
    <div className="mt-1 flex items-center gap-2">
      <Button type="submit" disabled={busy || !(withCode ? code.length === 6 && password : email.trim() && (step !== 'entrar' || password))} className="px-3 py-1.5">{busy ? 'Aguarde…' : action}</Button>
    </div>
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {step === 'entrar' && <>
        <span>Não tem conta? <button type="button" className={link} onClick={() => go('cadastro')}>Criar conta</button></span>
        <span aria-hidden>·</span>
        <button type="button" className={link} onClick={() => go('esqueci')}>Esqueci a senha</button>
      </>}
      {withCode && <><span>Não chegou? <button type="button" className={link} disabled={busy} onClick={() => void send({ acao: step === 'codigo-cadastro' ? 'cadastro' : 'esqueci', email }, step)}>Reenviar código</button></span><span aria-hidden>·</span></>}
      {step !== 'entrar' && <span>Já tem conta? <button type="button" className={link} onClick={() => go('entrar')}>Entrar</button></span>}
    </div>
  </form>
}

function PairingCard({ invite, now, onCancel }: { invite: MobilePairing; now: number; onCancel(): void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => { void navigator.clipboard.writeText(invite.url).then(() => setCopied(true)) }
  return <div className="mx-5 mt-4 flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-start">
    <img src={invite.qr} alt="QR code da nova conexão" width="176" height="176" className="mx-auto shrink-0 rounded bg-white sm:mx-0" />
    <div className="flex min-w-0 flex-1 flex-col gap-2 text-xs">
      <span className="font-semibold">Conectar um celular</span>
      <ol className="flex list-decimal flex-col gap-1 pl-4 text-muted-foreground">
        <li>No celular, abra o app Kora e toque em <strong className="text-foreground">Ler QR code</strong>.</li>
        <li>Aponte para este código. Sem câmera à mão, use <strong className="text-foreground">Colar convite</strong> no app.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="px-2.5 py-1" onClick={copy}><Icon name="copiar" />{copied ? 'Convite copiado' : 'Copiar convite'}</Button>
        <button type="button" className="text-[11px] text-muted-foreground underline hover:text-foreground" onClick={onCancel}>Cancelar</button>
        <span role="timer" className="ml-auto text-[11px] tabular-nums text-muted-foreground">Expira em {countdown(Date.parse(invite.expiresAt) - now)}</span>
      </div>
      {invite.app && <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">Ainda não tem o app no celular?</summary>
        <div className="mt-2 flex items-center gap-3">
          <img src={invite.app.qr} alt="QR code para baixar o app" width="96" height="96" className="shrink-0 rounded bg-white" />
          <span>Leia com a câmera do celular, no mesmo Wi-Fi, para baixar o app Kora deste PC. Depois, volte aqui e conecte.</span>
        </div>
      </details>}
    </div>
  </div>
}

function DeviceRow({ device, busy, away, onRename, onRevoke }: {
  device: MobileDevice
  busy: boolean
  away: boolean
  onRename(name: string): Promise<void>
  onRevoke(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const save = (): void => {
    const name = draft?.trim()
    setDraft(null)
    if (name && name !== device.name) void onRename(name)
  }
  const where = device.via === 'relay' ? 'fora de casa' : 'pela rede de casa'
  return <div className="group flex items-center gap-3 px-3 py-2 text-xs">
    <span className="relative shrink-0">
      <Icon name="celular" className="size-4" />
      <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card', device.online ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
    </span>
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
      <span className="truncate font-medium">{device.name}</span>
      <span className="text-[11px] text-muted-foreground">{device.online ? `Conectado agora, ${where}` : 'Desconectado'}</span>
    </span>}
    {draft === null && away && <span className={cn('hidden shrink-0 rounded-full border px-2 py-0.5 text-[10px] sm:inline', device.ready ? 'text-muted-foreground' : 'border-[var(--brand-amber)]/60 text-[var(--brand-amber)]')}
      data-tip={device.ready ? undefined : 'Abra o app uma vez no Wi-Fi de casa para ele poder entrar de fora'}>
      {device.ready ? 'Pronto para fora de casa' : 'Abra em casa uma vez'}
    </span>}
    {draft === null && <>
      <button type="button" aria-label={`Renomear ${device.name}`} data-tip="Renomear" disabled={busy} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => setDraft(device.name)}><Icon name="editar" className="size-3.5" /></button>
      <button type="button" aria-label={`Desvincular ${device.name}`} data-tip="Desvincular" disabled={busy} className="shrink-0 rounded p-1 hover:bg-secondary" onClick={onRevoke}><Icon name="excluir" className="size-3.5" /></button>
    </>}
  </div>
}
