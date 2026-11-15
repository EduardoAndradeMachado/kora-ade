import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/brand/icons'
import { cn } from '@/lib/utils'
import { foldText, formatNumber } from '@/lib/sheet-value'
import { distinctValues, type ColumnFilter, type Rows, type SortDir } from '@/lib/sheet-view'

// Lista com milhares de caixas de marcar trava a janela; acima disso, o "Contém" acha o resto.
const MAX_LISTED = 500

interface Props {
  rows: Rows
  // Linhas que passam nos filtros das outras colunas: é delas que saem os valores da lista, como no Excel.
  candidates: readonly number[]
  col: number
  label: string
  anchor: DOMRect
  filter: ColumnFilter | undefined
  sort: SortDir | null
  onSort(dir: SortDir | null): void
  onChange(filter: ColumnFilter | null): void
  onClose(): void
}

const shownValue = (value: string): string => (value === '' ? '(Vazias)' : value)

export function SheetFilterMenu({ rows, candidates, col, label, anchor, filter, sort, onSort, onChange, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 })
  const contains = filter?.contains ?? ''
  const excluded = filter?.excluded ?? new Set<string>()

  const values = useMemo(() => distinctValues(rows, candidates, col), [rows, candidates, col])
  const needle = foldText(contains.trim())
  const matching = useMemo(() => (needle === '' ? values : values.filter((v) => foldText(v.value).includes(needle))), [values, needle])
  const listed = matching.slice(0, MAX_LISTED)
  const allChecked = matching.every((v) => !excluded.has(v.value))
  const noneChecked = matching.every((v) => excluded.has(v.value))

  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(anchor.left, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 4))
    })
  }, [anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const update = (next: ColumnFilter): void => onChange(next)
  const setExcluded = (next: Set<string>): void => update({ contains, excluded: next })

  const toggle = (value: string): void => {
    const next = new Set(excluded)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setExcluded(next)
  }

  // Marcar/desmarcar tudo vale para o que a lista mostra (o que bate com o "Contém"), como no Excel.
  const toggleAll = (): void => {
    const next = new Set(excluded)
    for (const v of matching) {
      if (allChecked) next.add(v.value)
      else next.delete(v.value)
    }
    setExcluded(next)
  }

  const sortButton = (dir: SortDir, text: string): React.JSX.Element => (
    <button
      type="button"
      aria-pressed={sort === dir}
      onClick={() => onSort(sort === dir ? null : dir)}
      className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-secondary', sort === dir && 'text-[var(--brand-amber)]')}
    >
      <Icon name={dir === 'asc' ? 'setaCima' : 'setaBaixo'} className="size-3.5" />
      {text}
    </button>
  )

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Filtro de ${label}`}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 flex max-h-[min(28rem,calc(100vh-8px))] w-64 max-w-[calc(100vw-8px)] flex-col gap-1 rounded-lg border bg-card p-1.5 text-xs shadow-xl"
    >
      <div className="truncate px-2 pt-0.5 font-medium" data-tip={label}>
        {label}
      </div>
      {sortButton('asc', 'Ordenar crescente')}
      {sortButton('desc', 'Ordenar decrescente')}
      <div className="my-0.5 border-t" />
      <input
        autoFocus
        aria-label="Contém"
        placeholder="Contém…"
        spellCheck={false}
        value={contains}
        onChange={(e) => update({ contains: e.target.value, excluded })}
        className="h-7 shrink-0 rounded border bg-background px-2 text-foreground outline-none focus:border-[var(--brand-amber)]"
      />
      <label className="flex shrink-0 cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-secondary">
        <input
          type="checkbox"
          checked={allChecked && matching.length > 0}
          ref={(el) => {
            if (el) el.indeterminate = !allChecked && !noneChecked
          }}
          onChange={toggleAll}
          className="accent-[var(--brand-amber)]"
        />
        <span className="flex-1">(Selecionar tudo)</span>
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {listed.map((v) => (
          <label key={v.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 hover:bg-secondary">
            <input type="checkbox" checked={!excluded.has(v.value)} onChange={() => toggle(v.value)} className="shrink-0 accent-[var(--brand-amber)]" />
            <span className={cn('min-w-0 flex-1 truncate', v.value === '' && 'italic text-muted-foreground')} data-tip={v.value.length > 30 ? v.value : undefined}>
              {shownValue(v.value)}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{formatNumber(v.count)}</span>
          </label>
        ))}
        {matching.length === 0 && <p className="px-2 py-1 text-muted-foreground">Nenhum valor.</p>}
        {matching.length > MAX_LISTED && (
          <p className="px-2 py-1 text-muted-foreground">
            Mostrando {formatNumber(MAX_LISTED)} de {formatNumber(matching.length)} valores. Use o “Contém” para achar os outros.
          </p>
        )}
      </div>
      <div className="flex shrink-0 justify-end gap-1 border-t pt-1.5">
        <button
          type="button"
          disabled={!filter}
          onClick={() => onChange(null)}
          className="rounded-md border px-2 py-0.5 hover:bg-secondary disabled:opacity-50 disabled:hover:bg-transparent"
        >
          Limpar filtro
        </button>
        <button type="button" onClick={onClose} className="rounded-md border px-2 py-0.5 hover:bg-secondary">
          Fechar
        </button>
      </div>
    </div>,
    document.body
  )
}
