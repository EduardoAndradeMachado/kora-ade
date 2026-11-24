import { useEffect } from 'react'
import type { AgentKind } from '@shared/agent'
import { agentCommands } from '@shared/agent-commands'
import type { TranscriptStatus } from '@shared/transcript'
import { Icon } from '@/brand/icons'

// claude-opus-5-5 → Opus 5.5. Modelos de outros agentes ficam como o agente grava.
export function modelLabel(model: string): string {
  const claude = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (!claude) return model
  const family = claude[1]!
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
}

const MODES: Record<string, string> = {
  bypassPermissions: 'bypass',
  acceptEdits: 'aceita edições',
  plan: 'plano',
  default: 'pede permissão',
  auto: 'automático'
}

const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))

export function contextLabel(status: TranscriptStatus): string | null {
  if (status.contextTokens === undefined) return null
  if (!status.contextWindow) return `${tokens(status.contextTokens)} contexto`
  return `${Math.round((status.contextTokens / status.contextWindow) * 100)}% contexto`
}

export function ReadingStatus({ kind, status, connected, open, onOpen, onSend }: {
  kind: AgentKind
  status: TranscriptStatus
  connected: boolean
  // A folha entra no histórico (rota modelSheet): o voltar do celular fecha só ela.
  open: boolean
  onOpen(open: boolean): void
  // Manda o texto ao agente; picker: o comando abre um seletor no terminal, e a tela troca para ele.
  onSend(text: string, picker: boolean): void
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onOpen(false) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, onOpen])
  const parts = [status.model && modelLabel(status.model), status.effort, contextLabel(status), status.mode && (MODES[status.mode] ?? status.mode)].filter(Boolean) as string[]
  const commands = agentCommands(kind)
  const model = commands.find((c) => c.name === '/model' || c.name === '/models')
  const effort = commands.find((c) => c.name === '/effort')
  const send = (text: string, picker: boolean): void => {
    onOpen(false)
    onSend(text, picker)
  }
  if (parts.length === 0 && !model) return null
  return <>
    <button type="button" className="reading-status" aria-label="Modelo e raciocínio" disabled={!model} onClick={() => onOpen(true)}>
      {parts.length ? parts.map((part, index) => <span key={index}>{part}</span>) : <span>Modelo</span>}
      {model && <Icon name="expandir" className="reading-status-more" />}
    </button>
    {open && model && <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onOpen(false) }}>
      <section className="action-sheet reading-sheet" role="dialog" aria-modal="true" aria-label="Modelo e raciocínio">
        <div className="sheet-handle" /><header className="sheet-header"><h1>Modelo e raciocínio</h1><button className="icon-button" aria-label="Fechar" onClick={() => onOpen(false)}><Icon name="fechar" /></button></header>
        {model.options ? <>
          <h2 className="reading-sheet-label">Modelo</h2>
          <div className="reading-chips">{model.options.map((option) => <button type="button" key={option} disabled={!connected} aria-pressed={status.model?.includes(option) ?? false} onClick={() => send(`${model.name} ${option}`, false)}>{option}</button>)}</div>
        </> : <button type="button" className="action-row" disabled={!connected} onClick={() => send(model.name, true)}><Icon name="terminal" active />Escolher o modelo no terminal</button>}
        {effort?.options && <>
          <h2 className="reading-sheet-label">Raciocínio</h2>
          <div className="reading-chips">{effort.options.map((option) => <button type="button" key={option} disabled={!connected} aria-pressed={status.effort === option} onClick={() => send(`${effort.name} ${option}`, false)}>{option}</button>)}</div>
        </>}
        <p className="sheet-description">A troca vale a partir da próxima mensagem.</p>
      </section>
    </div>}
  </>
}
