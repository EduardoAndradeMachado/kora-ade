import type { GitOperation, GitStatus } from '@shared/git-types'
import { Icon } from '@/brand/icons'
import { Button } from '@/brand/Button'

const TITLE: Record<GitOperation['kind'], string> = {
  merge: 'Merge em andamento',
  rebase: 'Rebase em andamento',
  'cherry-pick': 'Cherry-pick em andamento',
  revert: 'Revert em andamento'
}

export function operationTitle(operation: GitOperation): string {
  const step = operation.kind === 'rebase' && operation.step && operation.total ? ` (passo ${operation.step} de ${operation.total})` : ''
  return TITLE[operation.kind] + step
}

const pendingText = (n: number): string =>
  n === 1 ? '1 arquivo em conflito. Resolva e marque como resolvido.' : `${n} arquivos em conflito. Resolva e marque como resolvidos.`

// Topo do painel enquanto o git está no meio de um merge/rebase/cherry-pick (ou com conflitos de um stash aplicado).
// Concluir só habilita sem conflito pendente, como o "Continuar" do VS Code.
export function ConflictBanner({
  status,
  disabled,
  onAbort,
  onContinue
}: {
  status: GitStatus | null
  disabled: boolean
  onAbort(): void
  onContinue(): void
}): React.JSX.Element | null {
  if (!status?.isRepo) return null
  const operation = status.operation ?? null
  const pending = status.files.filter((f) => f.status === 'conflicted').length
  if (!operation && pending === 0) return null
  const continueLabel = operation?.kind === 'merge' ? 'Concluir merge' : 'Continuar'

  return (
    <div data-git-operation={operation?.kind ?? 'conflitos'} className="flex shrink-0 flex-col gap-1.5 border-b bg-amber-500/10 px-3 py-2 text-xs">
      <div className="flex items-start gap-1.5">
        <Icon name="alerta" className="mt-px size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{operation ? operationTitle(operation) : 'Arquivos em conflito'}</p>
          <p className="text-[11px] text-muted-foreground">
            {pending > 0 ? pendingText(pending) : 'Sem conflitos pendentes. Conclua para gravar o commit.'}
          </p>
        </div>
      </div>
      {operation && (
        <div className="flex justify-end gap-1.5">
          <Button variant="secondary" disabled={disabled} onClick={onAbort} className="px-2.5 py-1">
            Abortar
          </Button>
          <Button
            disabled={disabled || pending > 0}
            onClick={onContinue}
            data-tip={pending > 0 ? 'Marque todos os conflitos como resolvidos antes' : undefined}
            className="px-2.5 py-1"
          >
            <Icon name="ok" className="size-3.5" />
            {continueLabel}
          </Button>
        </div>
      )}
    </div>
  )
}
