import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ClaudeAccount, ClaudeAccountsView, WeeklyUsage } from '@shared/claude-accounts'
import { formatRemaining, formatResetAt, isCritical } from '@shared/usage-format'
import { Icon } from '@/brand/icons'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { useWindowDim } from '@/lib/use-window-dim'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'

const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60_000

// A validade do login só aparece quando pede ação: perto de vencer ou vencida.
export function expiryText(account: ClaudeAccount, now: number): { text: string | null; tone: 'ok' | 'warn' | 'expired' } {
  const at = account.refreshTokenExpiresAt
  if (at === null) return { text: null, tone: 'ok' }
  if (at <= now) return { text: 'login vencido', tone: 'expired' }
  if (at - now <= EXPIRY_WARNING_MS) return { text: `login vence em ${formatRemaining(at - now)}`, tone: 'warn' }
  return { text: null, tone: 'ok' }
}

export function weeklyText(weekly: WeeklyUsage | null, now: number): { text: string; critical: boolean } {
  if (!weekly) return { text: 'Uso semanal ainda não registrado', critical: false }
  if (weekly.resetsAt === null || weekly.resetsAt <= now) return { text: 'Semanal renovado', critical: false }
  return {
    text: `Semanal ${Math.round(weekly.usedPercent)}% · renova ${formatResetAt(weekly.resetsAt, now)}`,
    critical: isCritical(weekly.usedPercent)
  }
}

function AccountsDialog({ onClose, children }: { onClose(): void; children: React.ReactNode }): React.JSX.Element {
  useWindowDim()
  useEffect(() => {
    // Na captura e parando ali: o Esc fecha só o modal, não o popup de limites que fica embaixo.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Contas do Claude"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-4 text-card-foreground shadow-2xl"
      >
        <div className="flex items-center gap-2">
          <AgentIcon kind="claude" className="size-4" />
          <h2 className="text-sm font-semibold">Contas do Claude</h2>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Icon name="fechar" className="size-3.5" />
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Trocar muda o login do Claude Code no computador todo; os Claude abertos depois disso usam a conta escolhida.
        </p>
        {children}
      </div>
    </div>,
    document.body
  )
}

// A conta conectada no cabeçalho do Claude no popup de limites; o clique abre o modal com as contas guardadas.
// A conta ativa mostra o mesmo semanal do medidor (liveWeekly); as outras, o último que o Kora gravou dela.
export function ClaudeAccountSwitcher({
  now,
  liveWeekly,
  onSwitched
}: {
  now: number
  liveWeekly: WeeklyUsage | null
  onSwitched(): void
}): React.JSX.Element {
  const [view, setView] = useState<ClaudeAccountsView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  const load = useCallback(() => {
    window.kora.claudeAccounts().then(setView, (err: unknown) => setError(ipcErrorMessage(err)))
  }, [])

  useEffect(() => {
    load()
    return window.kora.onClaudeAccountsChanged(load)
  }, [load])

  const run = async (key: string, action: () => Promise<ClaudeAccountsView | void>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      const next = await action()
      if (next) setView(next)
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const switchTo = (id: string): Promise<void> =>
    run(id, async () => {
      const next = await window.kora.switchClaudeAccount(id)
      onSwitched()
      setOpen(false)
      return next
    })

  const login = view?.login ?? null
  const loggingIn = login?.state === 'running'

  const active = view?.accounts.find((a) => a.active)
  const label = active?.email ?? (view === null ? '…' : view.activeUnknown ? 'Conta não identificada' : 'Entrar numa conta')

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tip="Trocar a conta do Claude"
        className="ml-auto flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <span className="truncate">{label}</span>
        <Icon name="expandir" className="size-3 shrink-0 rotate-90" />
      </button>
      {open && (
        <AccountsDialog onClose={close}>
    <section className="flex flex-col gap-2">
      {view?.accounts.map((account) => {
        const expiry = expiryText(account, now)
        const weekly = weeklyText((account.active ? liveWeekly : null) ?? account.weekly, now)
        return (
          <div key={account.id} className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              disabled={account.active || busy !== null || expiry.tone === 'expired'}
              onClick={() => void switchTo(account.id)}
              aria-pressed={account.active}
              data-tip={[account.organizationName, account.active ? 'Conta em uso no Claude Code' : 'Usar esta conta no Claude Code']
                .filter(Boolean)
                .join(' · ')}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left',
                account.active ? 'bg-secondary' : 'hover:bg-secondary disabled:hover:bg-transparent'
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {account.active && <Icon name="ok" className="size-3.5 text-[var(--brand-amber)]" />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs">{busy === account.id ? 'Trocando…' : account.email}</span>
                <span className={cn('truncate text-[11px] text-muted-foreground', weekly.critical && 'text-destructive')}>
                  {weekly.text}
                </span>
                {expiry.text && (
                  <span
                    className={cn(
                      'truncate text-[11px]',
                      expiry.tone === 'warn' ? 'text-[var(--brand-amber)]' : 'text-destructive'
                    )}
                  >
                    {expiry.text}
                  </span>
                )}
              </span>
            </button>
            {expiry.tone === 'expired' && (
              <button
                type="button"
                disabled={busy !== null || loggingIn}
                onClick={() => void run(`login:${account.id}`, () => window.kora.startClaudeLogin(account.email))}
                className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                Entrar de novo
              </button>
            )}
            {!account.active && (
              <button
                type="button"
                disabled={busy !== null}
                aria-label={`Remover ${account.email} do Kora`}
                data-tip="Remover do Kora (dá para entrar de novo depois)"
                onClick={() => void run(`remove:${account.id}`, () => window.kora.removeClaudeAccount(account.id))}
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Icon name="excluir" className="size-3.5" />
              </button>
            )}
          </div>
        )
      })}
      {view?.activeUnknown && (
        <p className="text-[11px] text-muted-foreground">
          O login atual do Claude Code não foi identificado. Abra o Claude uma vez para renovar.
        </p>
      )}
      {login?.state === 'running' ? (
        <div className="flex flex-col gap-1.5 rounded-md border p-2">
          <span className="text-xs">Conclua o login no navegador.</span>
          <div className="flex items-center gap-1.5">
            {login.url && (
              <button
                type="button"
                onClick={() => window.open(login.url!)}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                Abrir o navegador de novo
              </button>
            )}
            <button
              type="button"
              onClick={() => window.kora.cancelClaudeLogin()}
              className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              Cancelar
            </button>
          </div>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              window.kora.sendClaudeLoginCode(code)
              setCode('')
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Se a página mostrar um código, cole aqui"
              aria-label="Código de login"
              className="min-w-0 flex-1 rounded-md border bg-background px-1.5 py-1 text-[11px]"
            />
            <button
              type="submit"
              disabled={code.trim() === ''}
              className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              Enviar
            </button>
          </form>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run('login', () => window.kora.startClaudeLogin())}
          className="self-start rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          + Adicionar conta
        </button>
      )}
      {login?.state === 'failed' && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <Icon name="alerta" className="mt-px size-3 shrink-0" />
          <span className="min-w-0 flex-1">{login.message}</span>
          <button type="button" aria-label="Fechar aviso" onClick={() => window.kora.dismissClaudeLogin()}>
            <Icon name="fechar" className="size-3" />
          </button>
        </p>
      )}
      {error && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <Icon name="alerta" className="mt-px size-3 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </section>
        </AccountsDialog>
      )}
    </>
  )
}
