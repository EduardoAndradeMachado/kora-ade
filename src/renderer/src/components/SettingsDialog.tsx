import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { UpdateStatus } from '@shared/update'
import { Button } from '@/brand/Button'
import { Icon } from '@/brand/icons'
import { Lockup, SymbolMark } from '@/brand/Logo'

const SITE_URL = 'https://kora-ade.vercel.app/'
const REPO_URL = 'https://github.com/EduardoAndradeMachado/kora-ade'

interface Props {
  version: string | null
  update: UpdateStatus
  onCheck(): void
  onInstall(): void
  installing: boolean
  onClose(): void
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

export function SettingsDialog(props: Props): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const { update } = props

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const busy = update.state === 'checking' || update.state === 'downloading'

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-[1px]" onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-xl border bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">Configurações</h2>
          <button ref={closeRef} type="button" title="Fechar" onClick={props.onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <Icon name="fechar" className="size-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-4 px-4 py-4">
          <SymbolMark size={56} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <Lockup height={22} />
            <span className="text-xs text-muted-foreground" data-app-version>
              Versão {props.version ?? '…'}
            </span>
          </div>
        </div>

        <section className="flex flex-col gap-2.5 border-t px-4 py-3.5">
          <h3 className="text-xs font-semibold">Atualização</h3>
          <p role="status" className="text-xs leading-relaxed text-muted-foreground">
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

        <section className="flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-3 text-xs">
          <a href={SITE_URL} target="_blank" rel="noreferrer" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Site do Kora
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Código no GitHub
          </a>
        </section>
      </div>
    </div>,
    document.body
  )
}
