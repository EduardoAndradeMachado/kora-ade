import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/brand/Button'
import { useWindowDim } from '@/lib/use-window-dim'

// Pergunta com mais saídas que o ConfirmDialog (ex.: "Fazer stash e trocar", "Levar as alterações", "Forçar"),
// no mesmo visual. Cancelar fica sempre à esquerda, como no ConfirmDialog.

export interface ChoiceOption<T extends string> {
  id: T
  label: string
  variant?: 'primary' | 'secondary' | 'danger'
}

export interface ChoiceRequest<T extends string> {
  title: string
  message?: React.ReactNode
  options: ChoiceOption<T>[]
}

type Pending = ChoiceRequest<string> & { resolve(choice: string): void }

export function useChoiceDialog(): {
  ask<T extends string>(request: ChoiceRequest<T>): Promise<T | 'cancel'>
  dialog: React.ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const ask = useCallback(
    <T extends string>(request: ChoiceRequest<T>) =>
      new Promise<T | 'cancel'>((resolve) => setPending({ ...request, resolve: (choice) => resolve(choice as T | 'cancel') })),
    []
  )
  const answer = useCallback(
    (choice: string) => {
      pending?.resolve(choice)
      setPending(null)
    },
    [pending]
  )
  return { ask, dialog: pending ? <ChoiceDialog request={pending} onAnswer={answer} /> : null }
}

function ChoiceDialog({ request, onAnswer }: { request: Pending; onAnswer(choice: string): void }): React.JSX.Element {
  const firstRef = useRef<HTMLButtonElement>(null)
  useWindowDim()

  useEffect(() => {
    firstRef.current?.focus()
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
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-md rounded-xl border bg-card p-4 shadow-2xl">
        <h2 className="text-sm font-semibold">{request.title}</h2>
        {request.message && <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{request.message}</div>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => onAnswer('cancel')}>
            Cancelar
          </Button>
          {request.options.map((option, i) => (
            <Button key={option.id} ref={i === 0 ? firstRef : undefined} variant={option.variant ?? 'secondary'} onClick={() => onAnswer(option.id)}>
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
