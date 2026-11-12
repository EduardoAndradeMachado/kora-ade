import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

// Edição do nome aberta em mais de um lugar ao mesmo tempo (barra de cima e lateral): os campos dividem o
// mesmo rascunho, e passar o foco de um para o outro não encerra a edição.
export interface LinkedRename {
  tabId: string
  draft: string
  onChange(draft: string): void
  onFinish(commit: boolean): void
}

export const LinkedRenameContext = createContext<LinkedRename | null>(null)

interface Props {
  value: string
  editable: boolean
  className?: string
  tooltip?: string
  // Muda de valor quando algo de fora (ex.: "Renomear" no menu) pede para abrir a edição.
  editRequest?: number
  // Liga este título à edição compartilhada de LinkedRenameContext quando ela é dessa aba.
  linkId?: string
  linkFocus?: boolean
  onCommit(value: string): void
}

const inputClass = 'min-w-0 flex-1 rounded-sm bg-card px-1 text-xs text-foreground outline-none ring-1 ring-ring select-text'

export function EditableTitle({ value, editable, className, tooltip, editRequest, linkId, linkFocus, onCommit }: Props): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const link = useContext(LinkedRenameContext)
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

  if (editable && link && linkId && link.tabId === linkId) return <LinkedInput link={link} focus={linkFocus ?? false} />

  if (draft === null) {
    return (
      <span
        className={cn('truncate', className)}
        data-tip={tooltip ?? (editable ? `${value} — duplo clique para renomear` : value)}
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
      className={inputClass}
    />
  )
}

function LinkedInput({ link, focus }: { link: LinkedRename; focus: boolean }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)

  // Seleciona tudo só na abertura: voltar a este campo depois de digitar no outro mantém o cursor onde o clique caiu.
  useEffect(() => {
    if (!focus) return
    ref.current?.focus()
    ref.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <input
      ref={ref}
      data-rename-link={link.tabId}
      value={link.draft}
      onChange={(e) => link.onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') link.onFinish(true)
        if (e.key === 'Escape') link.onFinish(false)
      }}
      onBlur={(e) => {
        const next = e.relatedTarget
        if (next instanceof HTMLElement && next.dataset.renameLink === link.tabId) return
        link.onFinish(true)
      }}
      placeholder="vazio = nome automático"
      className={inputClass}
    />
  )
}
