import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/brand/Button'
import { useWindowDim } from '@/lib/use-window-dim'

export interface ConfirmOptions {
  title: string
  message?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export type Choice = 'confirm' | 'alternative' | 'cancel'
type Confirm = (options: ConfirmOptions) => Promise<boolean>
// Terceira saída entre Cancelar e a principal (ex.: "Fechar sem salvar" ao lado de "Salvar e fechar").
type Choose = (options: ConfirmOptions & { alternativeLabel: string }) => Promise<Choice>

const ConfirmContext = createContext<{ confirm: Confirm; choose: Choose } | null>(null)

function useDialogs(): { confirm: Confirm; choose: Choose } {
  const dialogs = useContext(ConfirmContext)
  if (!dialogs) throw new Error('useConfirm fora do ConfirmProvider')
  return dialogs
}

export const useConfirm = (): Confirm => useDialogs().confirm
export const useChoose = (): Choose => useDialogs().choose

type Request = ConfirmOptions & { alternativeLabel?: string; resolve(choice: Choice): void }

export function ConfirmProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [request, setRequest] = useState<Request | null>(null)

  const choose = useCallback<Choose>((options) => new Promise<Choice>((resolve) => setRequest({ ...options, resolve })), [])
  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve: (choice) => resolve(choice === 'confirm') })),
    []
  )
  const dialogs = useMemo(() => ({ confirm, choose }), [confirm, choose])

  const answer = (choice: Choice): void => {
    request?.resolve(choice)
    setRequest(null)
  }

  return (
    <ConfirmContext.Provider value={dialogs}>
      {children}
      {request && <Dialog request={request} onAnswer={answer} />}
    </ConfirmContext.Provider>
  )
}

function Dialog({ request, onAnswer }: { request: Request; onAnswer(choice: Choice): void }): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useWindowDim()

  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer('cancel')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-[1px]"
      onMouseDown={() => onAnswer('cancel')}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border bg-card p-4 shadow-2xl"
      >
        <h2 className="text-sm font-semibold">{request.title}</h2>
        {request.message && <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{request.message}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onAnswer('cancel')}>
            {request.cancelLabel ?? 'Cancelar'}
          </Button>
          {request.alternativeLabel && (
            <Button variant="secondary" onClick={() => onAnswer('alternative')}>
              {request.alternativeLabel}
            </Button>
          )}
          <Button ref={confirmRef} variant={request.danger ? 'danger' : 'primary'} onClick={() => onAnswer('confirm')}>
            {request.confirmLabel ?? 'Confirmar'}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
