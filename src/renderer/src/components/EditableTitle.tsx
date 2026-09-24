import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  value: string
  editable: boolean
  className?: string
  // Muda de valor quando algo de fora (ex.: "Renomear" no menu) pede para abrir a edição.
  editRequest?: number
  onCommit(value: string): void
}

export function EditableTitle({ value, editable, className, editRequest, onCommit }: Props): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  // O pedido fica guardado no App depois de atendido; a aba que volta a ser desenhada (ex.: ao trocar de
  // projeto) nasce com esse pedido antigo e não pode tratá-lo como novo.
  const seenRequest = useRef(editRequest)

  useEffect(() => {
    if (editRequest === seenRequest.current) return
    seenRequest.current = editRequest
    if (editRequest && editable) setDraft(value)
    // Só o pedido de edição dispara; `value` mudando sozinho não reabre o campo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest])

  if (draft === null) {
    return (
      <span
        className={cn('truncate', className)}
        title={editable ? `${value} — duplo clique para renomear` : value}
        onDoubleClick={(e) => {
          if (!editable) return
          e.stopPropagation()
          setDraft(value)
        }}
      >
        {value}
      </span>
    )
  }

  const finish = (commit: boolean): void => {
    if (commit && draft.trim() !== value) onCommit(draft.trim())
    setDraft(null)
  }

  return (
    <input
      autoFocus
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
      placeholder="vazio = nome automático"
      className="min-w-0 flex-1 rounded-sm bg-card px-1 text-xs text-foreground outline-none ring-1 ring-ring select-text"
    />
  )
}
