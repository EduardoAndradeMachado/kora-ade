import { useCallback, useEffect, useState } from 'react'
import type { AntigravityAccountsView } from '@shared/antigravity-accounts'
import { Icon } from '@/brand/icons'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { AccountsDialog } from './ClaudeAccounts'

// A conta conectada no cabeçalho do Antigravity no popup de limites; o clique abre o modal com as contas guardadas.
// account: o e-mail que a leitura de cota tirou da credencial, para o cabeçalho não depender da lista do cofre.
export function AntigravityAccountSwitcher({ account, onSwitched }: { account?: string; onSwitched(): void }): React.JSX.Element {
  const [view, setView] = useState<AntigravityAccountsView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  const load = useCallback(() => {
    window.kora.antigravityAccounts().then(setView, (err: unknown) => setError(ipcErrorMessage(err)))
  }, [])

  useEffect(() => {
    load()
    return window.kora.onAntigravityAccountsChanged(load)
  }, [load])

  const run = async (key: string, action: () => Promise<AntigravityAccountsView>): Promise<boolean> => {
    setBusy(key)
    setError(null)
    try {
      setView(await action())
      return true
    } catch (err) {
      setError(ipcErrorMessage(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  const switchTo = async (id: string): Promise<void> => {
    if (await run(id, () => window.kora.switchAntigravityAccount(id))) {
      onSwitched()
      setOpen(false)
    }
  }

  const active = view?.accounts.find((a) => a.active)
  const label =
    active?.email ??
    (view?.adding ? 'Entrando numa conta nova' : account) ??
    (view === null ? '…' : view.activeUnknown ? 'Conta não identificada' : 'Nenhuma conta ativa')

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tip="Trocar a conta do agy"
        className="ml-auto flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <span className="truncate">{label}</span>
        <Icon name="expandir" className="size-3 shrink-0 rotate-90" />
      </button>
      {open && (
        <AccountsDialog
          agent="antigravity"
          title="Contas do Antigravity"
          description="Trocar muda o login do agy no computador todo. Feche os agy abertos antes: o próximo que abrir já entra na conta escolhida."
          onClose={close}
        >
          <section className="flex flex-col gap-2">
            {view?.accounts.map((account) => (
              <div key={account.id} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  disabled={account.active || busy !== null}
                  onClick={() => void switchTo(account.id)}
                  aria-pressed={account.active}
                  data-tip={account.active ? 'Conta em uso no agy' : 'Usar esta conta no agy'}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left',
                    account.active ? 'bg-secondary' : 'hover:bg-secondary disabled:hover:bg-transparent'
                  )}
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    {account.active && <Icon name="ok" className="size-3.5 text-[var(--brand-amber)]" />}
                  </span>
                  <span className="truncate text-xs">{busy === account.id ? 'Trocando…' : account.email}</span>
                </button>
                {!account.active && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-label={`Remover ${account.email} do Kora`}
                    data-tip="Remover do Kora (dá para entrar de novo depois)"
                    onClick={() => void run(`remove:${account.id}`, () => window.kora.removeAntigravityAccount(account.id))}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <Icon name="excluir" className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
            {view?.activeUnknown && (
              <p className="text-[11px] text-muted-foreground">
                O Kora não consegue guardar o login atual do agy; ele não troca para não perdê-lo. Entre de novo pelo agy.
              </p>
            )}
            {view?.adding ? (
              <div className="flex flex-col gap-1.5 rounded-md border p-2">
                <span className="text-xs">Abra o agy num terminal e entre com a outra conta.</span>
                <span className="text-[11px] text-muted-foreground">
                  O Kora guarda o login assim que o agy terminar. A conta anterior já está guardada.
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run('cancel-add', () => window.kora.cancelAddAntigravityAccount())}
                  className="self-end rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run('add', () => window.kora.addAntigravityAccount())}
                className="self-start rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                + Adicionar conta
              </button>
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
