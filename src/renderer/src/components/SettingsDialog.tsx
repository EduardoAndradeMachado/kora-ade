import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { UpdateStatus } from '@shared/update'
import type { Alerts } from '@shared/state'
import { Button } from '@/brand/Button'
import { Icon } from '@/brand/icons'
import { Lockup } from '@/brand/Logo'
import { cn } from '@/lib/utils'

const SITE_URL = 'https://kora-ade.vercel.app/'
const REPO_URL = 'https://github.com/EduardoAndradeMachado/kora-ade'

export interface SettingsPanelProps {
  version: string | null
  update: UpdateStatus
  onCheck(): void
  onInstall(): void
  installing: boolean
  onClose(): void
  alerts: Alerts
  onAlertsChange(next: Alerts): void
  onPreviewSound(): void
}

function Toggle(props: { checked: boolean; label: string; detail: string; onChange(checked: boolean): void; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        onClick={() => props.onChange(!props.checked)}
        className={cn(
          'relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors',
          props.checked ? 'bg-[var(--brand-amber)]' : 'bg-secondary ring-1 ring-inset ring-border'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left]',
            props.checked ? 'left-[14px]' : 'left-0.5'
          )}
        />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-foreground">{props.label}</span>
        <span className="text-[11px] leading-snug text-muted-foreground">{props.detail}</span>
        {props.children}
      </div>
    </div>
  )
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

function describe(update: UpdateStatus): string {
  switch (update.state) {
    case 'disabled':
      return 'A atualização automática só funciona no app instalado.'
    case 'idle':
      return 'O Kora procura versão nova sozinho logo depois de abrir.'
    case 'checking':
      return 'Procurando versão nova…'
    case 'downloading':
      return `Baixando a versão ${update.version}… ${update.percent}%`
    case 'ready':
      return `Versão ${update.version} baixada e pronta para instalar.`
    case 'current':
      return `Você está na versão mais recente (consultado às ${clock(update.checkedAt)}).`
    case 'error':
      return `Não foi possível consultar: ${update.message}`
  }
}

// Erro em vermelho e "em dia" em verde (mesmos tons do "adicionado" do git no explorador); o resto neutro.
const STATUS_COLOR: Partial<Record<UpdateStatus['state'], string>> = {
  error: 'text-destructive',
  current: 'text-[#587c0c] dark:text-[#73c991]'
}

const linkClass = 'text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'

function Links(): React.JSX.Element {
  return (
    <>
      <a href={SITE_URL} target="_blank" rel="noreferrer" className={linkClass}>
        Site do Kora
      </a>
      <a href={REPO_URL} target="_blank" rel="noreferrer" className={linkClass}>
        Código no GitHub
      </a>
    </>
  )
}

export function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const { update } = props
  const version = `Versão ${props.version ?? '…'}`
  const busy = update.state === 'checking' || update.state === 'downloading'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Configurações"
      onMouseDown={(e) => e.stopPropagation()}
      className="flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-xl border bg-card text-foreground shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">Configurações</h2>
        <button
          autoFocus
          type="button"
          title="Fechar"
          onClick={props.onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Icon name="fechar" className="size-3.5" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-5">
        <Lockup height={34} />
        <span className="rounded-full border px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{version}</span>
      </div>

      <section className="flex flex-col gap-2.5 border-t px-4 py-3.5">
        <h3 className="text-xs font-semibold">Atualização</h3>
        <p role="status" className={cn('text-xs leading-relaxed', STATUS_COLOR[update.state] ?? 'text-muted-foreground')}>
          {describe(update)}
        </p>
        {update.state === 'downloading' && (
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-[var(--brand-amber)] transition-[width]" style={{ width: `${update.percent}%` }} />
          </div>
        )}
        {update.state === 'ready' ? (
          <>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Atualizar fecha o Kora como no Sair e abre de novo; as abas voltam com Continuar.
            </p>
            <Button className="self-start" disabled={props.installing} onClick={props.onInstall}>
              {props.installing ? 'Atualizando…' : 'Atualizar agora'}
            </Button>
          </>
        ) : (
          <Button variant="secondary" className="self-start" disabled={busy || update.state === 'disabled'} onClick={props.onCheck}>
            {update.state === 'error' ? 'Tentar de novo' : 'Buscar atualização'}
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-3 border-t px-4 py-3.5">
        <h3 className="text-xs font-semibold">Avisos</h3>
        <Toggle
          checked={props.alerts.sound}
          label="Som quando uma sessão para"
          detail="Toca quando o Claude ou o Codex termina e fica esperando você. Não toca para a aba que você está olhando."
          onChange={(sound) => props.onAlertsChange({ ...props.alerts, sound })}
        >
          <button
            type="button"
            onClick={props.onPreviewSound}
            className="mt-1 self-start rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Ouvir
          </button>
        </Toggle>
        <Toggle
          checked={props.alerts.windowsNotification}
          label="Notificação do Windows"
          detail="Mostra o aviso no canto da tela quando a janela do Kora não está em foco."
          onChange={(windowsNotification) => props.onAlertsChange({ ...props.alerts, windowsNotification })}
        />
      </section>

      <section className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-3 text-xs">
        <Links />
      </section>
    </div>
  )
}

export function SettingsDialog(props: SettingsPanelProps): React.JSX.Element {
  const { onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-[1px]" onMouseDown={onClose}>
      <SettingsPanel {...props} />
    </div>,
    document.body
  )
}
