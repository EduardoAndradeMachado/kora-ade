import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { copyWithNotice } from './CopyActions'
import { showToast } from './toast'
import { GROUP_NAME_MAX, PROJECT_NAME_MAX, type Project } from '@shared/state'
import type { MobileCommand, MobileState } from '@shared/mobile'
import { sectionSiblings } from '@shared/arrange'
import { depthOf, drawOrder } from '@shared/groups'

export type Act = (command: MobileCommand) => Promise<{ groupId?: string }>
type View = 'main' | 'rename' | 'move' | 'remove'

// O mesmo que o menu do projeto na lateral do PC. Subir e descer em vez de arrastar: no celular o toque longo já abre
// esta folha e arrastar disputa com a rolagem da lista; a folha fica aberta para tocar várias vezes seguidas.
export function ProjectActions({ project, state, onClose, act, onRemoved }: {
  project: Project
  state: MobileState
  onClose(): void
  act: Act
  onRemoved(): void
}): React.JSX.Element {
  const [view, setView] = useState<View>('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState(project.name)
  const [groupName, setGroupName] = useState('')
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
  const groupsById = new Map(state.groups.map((group) => [group.id, group]))
  const current = project.hidden ? 'Ocultos' : project.groupId && groupsById.has(project.groupId) ? groupsById.get(project.groupId)!.name : 'Sem categoria'
  const siblings = sectionSiblings(state.projects, project.id, state.groups)
  const position = siblings.findIndex((p) => p.id === project.id)
  const { visible, hidden } = drawOrder(state.groups)
  const targets = [...visible, ...hidden].filter((group) => project.hidden || group.id !== project.groupId)
  const running = state.tabs.filter((tab) => tab.projectId === project.id && tab.live).length
  const place = (section: { hidden: true } | { hidden: false; groupId: string | null }, label: string): Promise<void> => run(async () => {
    await act({ type: 'place-project', projectId: project.id, section })
    showToast(label)
    onClose()
  })
  const back = <button className="icon-button" aria-label="Voltar às opções" disabled={busy} onClick={() => { setView('main'); setError('') }}><Icon name="expandir" className="back-icon" /></button>
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="project-action-title"><div className="sheet-handle" /><header className="sheet-header">{view !== 'main' && back}<div className="sheet-title"><span className="eyebrow">PROJETO · {current.toLocaleUpperCase('pt-BR')}</span><h1 id="project-action-title">{project.name}</h1></div><button className="icon-button" aria-label="Fechar opções" onClick={onClose} disabled={busy}><Icon name="fechar" /></button></header>
    {view === 'main' && <>
      <button className="action-row" onClick={() => void copyWithNotice(project.path, 'Caminho copiado.').then(onClose, (failure: Error) => setError(failure.message))}><Icon name="copiar" active />Copiar caminho</button>
      <button className="action-row" disabled={busy} onClick={() => setView('rename')}><Icon name="editar" active />Renomear<Icon name="expandir" /></button>
      <div className="action-pair" role="group" aria-label={`Posição em ${current}: ${position + 1} de ${siblings.length}`}>
        <button className="action-row" disabled={busy || position <= 0} onClick={() => void run(async () => { await act({ type: 'move-project', projectId: project.id, delta: -1 }) })}><Icon name="setaCima" active />Mover para cima</button>
        <button className="action-row" disabled={busy || position < 0 || position >= siblings.length - 1} onClick={() => void run(async () => { await act({ type: 'move-project', projectId: project.id, delta: 1 }) })}><Icon name="setaBaixo" active />Mover para baixo</button>
      </div>
      <button className="action-row" disabled={busy} onClick={() => setView('move')}><Icon name="mover" active />Mover para categoria<Icon name="expandir" /></button>
      <button className="action-row" disabled={busy} onClick={() => void place(project.hidden ? { hidden: false, groupId: null } : { hidden: true }, project.hidden ? 'Projeto de volta aos ativos.' : 'Projeto movido para Ocultos.')}><Icon name={project.hidden ? 'visualizar' : 'ocultar'} active />{project.hidden ? 'Mover para Ativos' : 'Ocultar'}</button>
      <button className="action-row danger-button" disabled={busy} onClick={() => setView('remove')}><Icon name="excluir" />Remover da lista<Icon name="expandir" /></button>
    </>}
    {view === 'rename' && <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { await act({ type: 'rename-project', projectId: project.id, name: name.trim() }); onClose() }) }}><label htmlFor="project-name">Nome do projeto</label><input id="project-name" value={name} maxLength={PROJECT_NAME_MAX} onChange={(event) => setName(event.target.value)} autoFocus /><small>Muda só o nome no Kora; a pasta no PC continua igual. Vazio volta ao nome da pasta.</small><button className="primary" disabled={busy}>Salvar nome</button></form>}
    {view === 'move' && <>
      {(project.hidden || (project.groupId && groupsById.has(project.groupId))) && <button className="action-row" disabled={busy} onClick={() => void place({ hidden: false, groupId: null }, 'Projeto sem categoria.')}><Icon name="mover" active />{project.hidden ? 'Sem categoria (ativos)' : 'Tirar da categoria'}</button>}
      {targets.map((group) => <button key={group.id} className="action-row" disabled={busy} style={{ paddingLeft: 8 + depthOf(state.groups, group.id) * 16 }} onClick={() => void place({ hidden: false, groupId: group.id }, `Projeto movido para ${group.name}.`)}><Icon name="projeto" active /><span className="action-label">{group.name}</span>{hidden.includes(group) && <small>oculta</small>}</button>)}
      <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        const { groupId } = await act({ type: 'group', action: { kind: 'create', name: groupName.trim(), parentId: null } })
        if (groupId) await act({ type: 'place-project', projectId: project.id, section: { hidden: false, groupId } })
        showToast(`Projeto movido para ${groupName.trim()}.`)
        onClose()
      }) }}><label htmlFor="project-new-group">Nova categoria</label><input id="project-new-group" value={groupName} maxLength={GROUP_NAME_MAX} placeholder="Nome da categoria" onChange={(event) => setGroupName(event.target.value)} /><button className="primary" disabled={busy || !groupName.trim()}><Icon name="novaCategoria" />Criar e mover</button></form>
    </>}
    {view === 'remove' && <div className="close-confirm"><p>Remover “{project.name}” da lista? {state.missingProjectIds.includes(project.id) ? 'A pasta não foi encontrada no PC; só o vínculo com o Kora é desfeito.' : 'A pasta e os arquivos continuam no PC; só o vínculo com o Kora é desfeito.'}</p>{running > 0 && <p><strong>{running === 1 ? '1 terminal aberto será fechado.' : `${running} terminais abertos serão fechados.`}</strong></p>}<div><button onClick={() => setView('main')} disabled={busy}>Cancelar</button><button className="danger-button" disabled={busy} onClick={() => void run(async () => { await act({ type: 'remove-project', projectId: project.id }); showToast('Projeto removido da lista.'); onRemoved() })}>Remover da lista</button></div></div>}
    {error && <p role="alert" className="sheet-notice">{error}</p>}
  </section></div>
}
