import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { GROUP_NAME_MAX, type ProjectGroup } from '@shared/state'
import type { MobileState } from '@shared/mobile'
import { childrenOf, depthOf, descendantIds, drawOrder, parentOf } from '@shared/groups'
import { showToast } from './toast'
import type { Act } from './ProjectActions'

type View = 'main' | 'rename' | 'child' | 'nest' | 'remove'

// O menu da categoria na lateral do PC. Sem categoria (group null), a folha só cria uma categoria nova na raiz.
export function GroupActions({ group, state, onClose, act }: {
  group: ProjectGroup | null
  state: MobileState
  onClose(): void
  act: Act
}): React.JSX.Element {
  const [view, setView] = useState<View>(group ? 'main' : 'child')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await task() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }
  const open = (next: View): void => {
    setName(next === 'rename' ? group?.name ?? '' : '')
    setError('')
    setView(next)
  }
  const groups = state.groups
  const nested = group ? parentOf(groups, group) !== null : false
  const siblings = group ? childrenOf(groups, parentOf(groups, group)) : []
  const position = group ? siblings.indexOf(group) : -1
  const inside = group ? descendantIds(groups, group.id) : new Set<string>()
  const { visible, hidden } = drawOrder(groups)
  const nestTargets = group ? [...visible, ...hidden].filter((g) => g.id !== group.id && !inside.has(g.id) && g.id !== group.parentId) : []
  const count = group ? state.projects.filter((p) => !p.hidden && p.groupId && (p.groupId === group.id || inside.has(p.groupId))).length : 0
  const shownHidden = Boolean(group?.hidden && !nested)
  const back = group && view !== 'main' && <button className="icon-button" aria-label="Voltar às opções" disabled={busy} onClick={() => open('main')}><Icon name="expandir" className="back-icon" /></button>
  const nameForm = (label: string, submit: string, onSubmit: (name: string) => Promise<void>): React.JSX.Element =>
    <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void run(() => onSubmit(name.trim())) }}><label htmlFor="group-name">{label}</label><input id="group-name" value={name} maxLength={GROUP_NAME_MAX} placeholder="Nome da categoria" onChange={(event) => setName(event.target.value)} autoFocus /><small>Categoria só organiza a lista do Kora; nenhuma pasta é criada no PC.</small><button className="primary" disabled={busy || !name.trim()}>{submit}</button></form>
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="group-action-title"><div className="sheet-handle" /><header className="sheet-header">{back}<div className="sheet-title"><span className="eyebrow">{group ? `CATEGORIA · ${count === 1 ? '1 PROJETO' : `${count} PROJETOS`}` : 'NOVA CATEGORIA'}</span><h1 id="group-action-title">{group?.name ?? 'Seus projetos'}</h1></div><button className="icon-button" aria-label="Fechar opções" onClick={onClose} disabled={busy}><Icon name="fechar" /></button></header>
    {group && view === 'main' && <>
      <button className="action-row" disabled={busy} onClick={() => open('child')}><Icon name="novaCategoria" active />Nova subcategoria<Icon name="expandir" /></button>
      <button className="action-row" disabled={busy} onClick={() => open('rename')}><Icon name="editar" active />Renomear<Icon name="expandir" /></button>
      <div className="action-pair" role="group" aria-label={`Posição: ${position + 1} de ${siblings.length}`}>
        <button className="action-row" disabled={busy || position <= 0} onClick={() => void run(async () => { await act({ type: 'group', action: { kind: 'move', id: group.id, delta: -1 } }) })}><Icon name="setaCima" active />Mover para cima</button>
        <button className="action-row" disabled={busy || position >= siblings.length - 1} onClick={() => void run(async () => { await act({ type: 'group', action: { kind: 'move', id: group.id, delta: 1 } }) })}><Icon name="setaBaixo" active />Mover para baixo</button>
      </div>
      {(nested || nestTargets.length > 0) && <button className="action-row" disabled={busy} onClick={() => open('nest')}><Icon name="mover" active />Mover para dentro de…<Icon name="expandir" /></button>}
      <button className="action-row" disabled={busy} onClick={() => void run(async () => { await act({ type: 'group', action: { kind: 'hide', id: group.id, hidden: !shownHidden } }); showToast(shownHidden ? 'Categoria de volta à lista.' : 'Categoria movida para Ocultos.'); onClose() })}><Icon name={shownHidden ? 'visualizar' : 'ocultar'} active />{shownHidden ? 'Mostrar categoria' : 'Ocultar categoria'}</button>
      <button className="action-row danger-button" disabled={busy} onClick={() => open('remove')}><Icon name="excluir" />Excluir categoria<Icon name="expandir" /></button>
    </>}
    {view === 'child' && nameForm(group ? `Nova subcategoria em “${group.name}”` : 'Nome da categoria', 'Criar categoria', async (value) => {
      await act({ type: 'group', action: { kind: 'create', name: value, parentId: group?.id ?? null } })
      showToast(`Categoria “${value}” criada.`)
      onClose()
    })}
    {group && view === 'rename' && nameForm('Nome da categoria', 'Salvar nome', async (value) => {
      await act({ type: 'group', action: { kind: 'rename', id: group.id, name: value } })
      onClose()
    })}
    {group && view === 'nest' && <>
      {nested && <button className="action-row" disabled={busy} onClick={() => void run(async () => { await act({ type: 'group', action: { kind: 'nest', id: group.id, parentId: null } }); onClose() })}><Icon name="mover" active />Tirar da categoria de cima</button>}
      {nestTargets.map((target) => <button key={target.id} className="action-row" disabled={busy} style={{ paddingLeft: 8 + depthOf(groups, target.id) * 16 }} onClick={() => void run(async () => { await act({ type: 'group', action: { kind: 'nest', id: group.id, parentId: target.id } }); showToast(`Categoria movida para ${target.name}.`); onClose() })}><Icon name="projeto" active /><span className="action-label">{target.name}</span>{hidden.includes(target) && <small>oculta</small>}</button>)}
    </>}
    {group && view === 'remove' && <div className="close-confirm"><p>Excluir a categoria “{group.name}”? Só a divisória sai: os projetos e as subcategorias dela sobem um nível. Nenhuma pasta é apagada.</p><div><button onClick={() => open('main')} disabled={busy}>Cancelar</button><button className="danger-button" disabled={busy} onClick={() => void run(async () => { await act({ type: 'group', action: { kind: 'remove', id: group.id } }); showToast('Categoria excluída.'); onClose() })}>Excluir categoria</button></div></div>}
    {error && <p role="alert" className="sheet-notice">{error}</p>}
  </section></div>
}
