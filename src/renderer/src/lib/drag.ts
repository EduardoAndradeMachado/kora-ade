import { useState } from 'react'
import type { Place } from '@shared/arrange'

// Item do explorador: dentro dele, move; o text/plain do mesmo arrasto leva o caminho absoluto para o terminal.
export const FILE_MIME = 'application/x-kora-file'

export interface DropHint {
  id: string
  place: Place
}

// Um tipo por lista no dataTransfer: durante o arrasto só os tipos são legíveis, e assim uma aba de outro
// projeto (ou um arquivo vindo do Windows) nem acende o indicador.
export const mimeFor = (scope: string): string => `application/x-kora-${scope.toLowerCase()}`

type DragHandlers = Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>

// Um mesmo alvo que aceita dois tipos de arrasto (ex.: cabeçalho de categoria recebe projeto e categoria):
// cada conjunto confere o próprio tipo e ignora o resto.
export function mergeDragHandlers(...all: DragHandlers[]): DragHandlers {
  const run = (key: keyof DragHandlers) => (e: React.DragEvent<HTMLElement>) => {
    for (const handlers of all) handlers[key]?.(e)
  }
  return { onDragOver: run('onDragOver'), onDragLeave: run('onDragLeave'), onDrop: run('onDrop') }
}

export function placeFor(event: React.DragEvent, axis: 'x' | 'y'): Place {
  const rect = event.currentTarget.getBoundingClientRect()
  const middle = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
  return (axis === 'x' ? event.clientX : event.clientY) < middle ? 'before' : 'after'
}

// Linha âmbar na borda onde o item vai entrar.
export function hintClass(hint: DropHint | null, id: string, axis: 'x' | 'y'): string {
  if (hint?.id !== id) return ''
  if (axis === 'x') return hint.place === 'before' ? 'shadow-[inset_2px_0_0_var(--brand-amber)]' : 'shadow-[inset_-2px_0_0_var(--brand-amber)]'
  return hint.place === 'before' ? 'shadow-[inset_0_2px_0_var(--brand-amber)]' : 'shadow-[inset_0_-2px_0_var(--brand-amber)]'
}

export interface ReorderDrag {
  hint: DropHint | null
  itemProps(id: string): React.HTMLAttributes<HTMLElement> & { draggable: boolean }
  // Alvo que não é um item (ex.: a divisória "Ocultos"): recebe o id arrastado.
  zoneProps(onDrop: (draggedId: string) => void): React.HTMLAttributes<HTMLElement>
  zoneActive: boolean
}

export function useReorderDrag(scope: string, axis: 'x' | 'y', onDrop: (draggedId: string, targetId: string, place: Place) => void): ReorderDrag {
  const mime = mimeFor(scope)
  const [hint, setHint] = useState<DropHint | null>(null)
  const [zoneActive, setZoneActive] = useState(false)
  const accepts = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(mime)

  return {
    hint,
    zoneActive,
    itemProps: (id) => ({
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData(mime, id)
        e.dataTransfer.effectAllowed = 'move'
      },
      onDragOver: (e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const place = placeFor(e, axis)
        setHint((h) => (h?.id === id && h.place === place ? h : { id, place }))
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHint((h) => (h?.id === id ? null : h))
      },
      onDrop: (e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        setHint(null)
        const dragged = e.dataTransfer.getData(mime)
        if (dragged) onDrop(dragged, id, placeFor(e, axis))
      },
      onDragEnd: () => setHint(null)
    }),
    zoneProps: (onZoneDrop) => ({
      onDragOver: (e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setZoneActive(true)
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZoneActive(false)
      },
      onDrop: (e) => {
        if (!accepts(e)) return
        e.preventDefault()
        setZoneActive(false)
        const dragged = e.dataTransfer.getData(mime)
        if (dragged) onZoneDrop(dragged)
      }
    })
  }
}
