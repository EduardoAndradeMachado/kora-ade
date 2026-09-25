import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/brand/icons'
import { Button } from '@/brand/Button'
import { SESSION_ID, type AgentKind, type AgentSession } from '@shared/agent'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { cn } from '@/lib/utils'

interface Props {
  agent: AgentSession | null
  visible: boolean
  startEditing?: boolean
  onResume(): void
  onShell(): void
  onSetAgent(agent: AgentSession | null): void
}

export function DormantView(props: Props): React.JSX.Element {
  const { agent, visible, onResume, onShell, onSetAgent } = props
  const [editing, setEditing] = useState(props.startEditing ?? false)
  const [kind, setKind] = useState<AgentKind>(agent?.kind ?? 'claude')
  const [sessionId, setSessionId] = useState(agent?.sessionId ?? '')
  const valid = SESSION_ID.test(sessionId.trim())
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const copyId = (id: string): void => {
    void navigator.clipboard.writeText(id).then(() => {
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div data-dormant className={cn('absolute inset-0 flex items-center justify-center bg-canvas px-6', !visible && 'invisible')}>
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        {agent ? (
          <>
            <AgentIcon kind={agent.kind} className="size-8" />
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">
                {agentLabel(agent.kind)}
                {agent.name ? ` · ${agent.name}` : ''}
              </div>
              <button
                type="button"
                title="Copiar ID da sessão"
                onClick={() => copyId(agent.sessionId)}
                className="mx-auto flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                {agent.sessionId}
                <Icon name={copied ? 'ok' : 'copiar'} className={cn('size-3', copied && 'text-[var(--brand-amber)]')} />
              </button>
              <span role="status" className="h-4 text-[11px] text-[var(--brand-amber)]">
                {copied ? 'Copiado' : ''}
              </span>
            </div>
            <Button onClick={onResume}>
              <Icon name="retomar" className="size-3.5" />
              Continuar chat
            </Button>
          </>
        ) : (
          <>
            <Icon name="terminal" className="size-8 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">Terminal sem sessão de agente vinculada.</div>
            <Button onClick={onShell}>Abrir terminal</Button>
          </>
        )}

        {/* Vincular à mão só na aba sem sessão (é o caminho do "Sessão existente"); a aba com sessão só continua. */}
        {agent ? null : !editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Vincular uma sessão manualmente
          </button>
        ) : (
          <form
            className="flex w-full flex-col gap-2 rounded-lg border bg-background p-3 text-left"
            onSubmit={(e) => {
              e.preventDefault()
              if (!valid) return
              onSetAgent({ kind, sessionId: sessionId.trim() })
              setEditing(false)
            }}
          >
            <div className="flex gap-1">
              {(['claude', 'codex'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
                    kind === k ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60'
                  )}
                >
                  <AgentIcon kind={k} className="size-3.5" />
                  {agentLabel(k)}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="ID da sessão (UUID)"
              className="w-full rounded-md border bg-card px-2 py-1.5 font-mono text-xs outline-none select-text focus:border-ring"
            />
            {sessionId && !valid && <span className="text-[11px] text-destructive">Formato esperado: UUID.</span>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
              >
                Cancelar
              </button>
              <Button type="submit" disabled={!valid} className="px-2.5 py-1">
                Salvar
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
