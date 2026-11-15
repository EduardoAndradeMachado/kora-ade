import { useEffect, useRef } from 'react'
import type { GitCheckoutMode, GitConflictCode, GitDeletionChoice, GitPullResult, GitPullStrategy, GitPushRewritten } from '@shared/git-types'
import type { GitState } from '@/lib/use-git'
import { useChoose, useConfirm } from '@/components/ConfirmDialog'
import { useChoiceDialog } from '@/components/git/ConflictChoiceDialog'

// Fluxos que precisam perguntar no meio (pull divergente, troca de branch barrada, conflito de exclusão, marcadores
// ainda no arquivo) e o merge/rebase em andamento. O GitPanel só chama estas funções.

export interface ConflictFlows {
  push(): void
  pull(): void
  sync(): void
  checkout(name: string, remote: string | null): void
  // Colocar na fila: arquivo em conflito vira "marcar como resolvido", com as perguntas do VS Code.
  stage(paths: string[]): void
  abort(): void
  continueOperation(): void
  dialog: React.ReactNode
}

const SKIP_SYNC_CONFIRM_KEY = 'kora.git.sincronizarSemPerguntar'

function readSkipSync(): boolean {
  try {
    return localStorage.getItem(SKIP_SYNC_CONFIRM_KEY) === '1'
  } catch {
    return false
  }
}

function saveSkipSync(): void {
  try {
    localStorage.setItem(SKIP_SYNC_CONFIRM_KEY, '1')
  } catch {
    // Sem armazenamento, a pergunta volta na próxima vez.
  }
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path
const commits = (n: number): string => `${n} ${n === 1 ? 'commit' : 'commits'}`

// "Nós" é o HEAD; "eles", o que está entrando. Mesmas frases do VS Code.
const DELETION: Record<Exclude<GitConflictCode, 'UU' | 'AA' | 'DD'>, { message(name: string): string; keep: string }> = {
  DU: { message: (n) => `O arquivo "${n}" foi excluído por nós e modificado por eles. O que você deseja fazer?`, keep: 'Manter versão deles' },
  UD: { message: (n) => `O arquivo "${n}" foi modificado por nós e excluído por eles. O que você deseja fazer?`, keep: 'Manter nossa versão' },
  AU: { message: (n) => `O arquivo "${n}" foi adicionado por nós e não existe do outro lado. O que você deseja fazer?`, keep: 'Manter nossa versão' },
  UA: { message: (n) => `O arquivo "${n}" foi adicionado por eles e não existe do nosso lado. O que você deseja fazer?`, keep: 'Manter versão deles' }
}

const MAX_LISTED = 6

function FileList({ files }: { files: string[] }): React.JSX.Element {
  const shown = files.slice(0, MAX_LISTED)
  return (
    <ul className="mt-1.5 list-none font-mono text-[11px] text-foreground">
      {shown.map((f) => (
        <li key={f} className="truncate">
          {f}
        </li>
      ))}
      {files.length > shown.length && <li className="text-muted-foreground">e mais {files.length - shown.length}</li>}
    </ul>
  )
}

export function useConflictFlows({
  projectId,
  git,
  commitDraft,
  onCommitDraftChange
}: {
  projectId: string
  git: GitState
  commitDraft: string
  onCommitDraftChange(update: (current: string) => string): void
}): ConflictFlows {
  const confirm = useConfirm()
  const choose = useChoose()
  const { ask, dialog } = useChoiceDialog()
  const kora = window.kora
  const operation = git.status?.isRepo ? (git.status.operation ?? null) : null

  // O resultado de uma ação feita pelo `run` (que cuida do "Aguarde…" e do erro); null se falhou.
  const attempt = async <T,>(action: () => Promise<T>, label: string): Promise<T | null> => {
    const box: { value?: T } = {}
    const ok = await git.run(async () => {
      box.value = await action()
    }, label)
    return ok && 'value' in box ? (box.value as T) : null
  }

  // A mensagem que o git preparou (MERGE_MSG) entra na caixa vazia, como no VS Code. Sai sozinha quando a
  // operação termina por fora (terminal, agente) e ninguém mexeu nela.
  const filled = useRef<string | null>(null)
  // Só no merge: rebase e cherry-pick continuam com a mensagem que o git guardou para o passo, não com a da caixa.
  const prepared = operation?.kind === 'merge' ? (operation.message ?? null) : null
  useEffect(() => {
    if (prepared) {
      if (filled.current === prepared) return
      filled.current = prepared
      onCommitDraftChange((current) => (current.trim() ? current : prepared))
    } else if (filled.current !== null) {
      const previous = filled.current
      filled.current = null
      onCommitDraftChange((current) => (current === previous ? '' : current))
    }
    // onCommitDraftChange muda a cada render do pai; só a mensagem preparada decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared])

  // Commit já enviado foi corrigido ou desfeito: o push comum seria recusado e o Pull traria o commit de volta.
  const forcePush = async (rewritten: GitPushRewritten): Promise<void> => {
    const n = rewritten.lost.length
    const ok = await confirm({
      title: 'Forçar push (com segurança)?',
      message: (
        <>
          <p>
            Você corrigiu ou desfez {n === 1 ? 'um commit que já estava' : `${n} commits que já estavam`} em {rewritten.upstream}. O push
            forçado substitui no remoto:
          </p>
          <FileList files={rewritten.lost.map((c) => `${c.hash.slice(0, 7)} ${c.subject}`)} />
          <p className="mt-2">Se alguém tiver enviado commits depois da sua última busca, o push é cancelado e nada se perde.</p>
        </>
      ),
      confirmLabel: 'Forçar push',
      danger: true
    })
    if (ok) await attempt(() => kora.gitPush(projectId, { forceWithLease: rewritten.remoteOid }), 'Enviando (push forçado)…')
  }

  const push = async (): Promise<void> => {
    const result = await attempt(() => kora.gitPush(projectId), 'Enviando (Push)…')
    if (result?.status === 'rewritten') await forcePush(result)
  }

  const afterPull = async (
    result: GitPullResult | GitPushRewritten | null,
    again: (strategy: GitPullStrategy) => Promise<GitPullResult | GitPushRewritten>,
    label: string
  ): Promise<void> => {
    if (result?.status === 'rewritten') return forcePush(result)
    if (result?.status !== 'diverged') return
    const branch = git.status?.branch ?? 'A branch'
    const choice = await ask({
      title: `Seu branch e o remoto divergiram (${result.ahead} à frente, ${result.behind} atrás)`,
      message: (
        <p>
          "{branch}" tem {commits(result.ahead)} que {result.upstream} não tem, e {result.upstream} tem {commits(result.behind)} que você
          ainda não tem. Mesclar cria um commit de merge; rebase reaplica os seus commits por cima dos do remoto.
        </p>
      ),
      options: [
        { id: 'merge', label: 'Mesclar (merge)', variant: 'primary' },
        { id: 'rebase', label: 'Rebase' }
      ]
    })
    if (choice === 'cancel') return
    const second = await attempt(() => again(choice), label)
    if (second?.status === 'rewritten') await forcePush(second)
  }

  const pull = async (): Promise<void> => {
    const label = 'Trazendo (Pull)…'
    await afterPull(await attempt(() => kora.gitPull(projectId), label), (s) => kora.gitPull(projectId, s), label)
  }

  const sync = async (): Promise<void> => {
    if (!readSkipSync()) {
      const upstream = git.status?.upstream ?? 'o remoto'
      const choice = await choose({
        title: 'Sincronizar?',
        message: `Faz Pull de ${upstream} e depois Push dos seus commits para ${upstream}.`,
        confirmLabel: 'OK',
        alternativeLabel: 'OK, não perguntar de novo'
      })
      if (choice === 'cancel') return
      if (choice === 'alternative') saveSkipSync()
    }
    const label = 'Sincronizando…'
    await afterPull(await attempt(() => kora.gitSync(projectId), label), (s) => kora.gitSync(projectId, s), label)
  }

  const checkout = async (name: string, remote: string | null): Promise<void> => {
    const result = await attempt(() => kora.gitCheckout(projectId, name, remote), 'Trocando de branch…')
    if (result?.status !== 'local-changes') return
    const choice = await ask<GitCheckoutMode>({
      title: `Suas alterações locais seriam sobrescritas ao trocar para "${name}"`,
      message: (
        <>
          <p>Arquivos com alteração que a troca sobrescreveria:</p>
          <FileList files={result.files} />
          <p className="mt-2">
            Fazer stash guarda as alterações e troca. Levar as alterações guarda, troca e as reaplica na outra branch (se
            conflitar, elas continuam no stash).
          </p>
        </>
      ),
      options: [
        { id: 'stash', label: 'Fazer stash e trocar', variant: 'primary' },
        { id: 'migrate', label: 'Levar as alterações' },
        { id: 'force', label: 'Forçar (descarta)', variant: 'danger' }
      ]
    })
    if (choice === 'cancel') return
    if (choice === 'force') {
      const ok = await confirm({
        title: `Descartar as alterações locais e trocar para "${name}"?`,
        message: 'Todas as alterações nos arquivos rastreados se perdem, e os não rastreados que estiverem no caminho são sobrescritos. Não dá para desfazer.',
        confirmLabel: 'Descartar e trocar',
        danger: true
      })
      if (!ok) return
    }
    const label = choice === 'force' ? 'Trocando e descartando…' : 'Guardando e trocando…'
    await attempt(() => kora.gitCheckout(projectId, name, remote, choice), label)
  }

  const resolveOne = async (path: string): Promise<void> => {
    const label = 'Marcando como resolvido…'
    let result = await attempt(() => kora.gitResolve(projectId, [path]), label)
    if (result?.status === 'needs-choice') {
      const texts = DELETION[result.conflict as keyof typeof DELETION]
      const choice = await ask<GitDeletionChoice>({
        title: 'Conflito de exclusão',
        message: <p>{texts.message(fileName(path))}</p>,
        options: [
          { id: 'keep', label: texts.keep, variant: 'primary' },
          { id: 'delete', label: 'Excluir arquivo', variant: 'danger' }
        ]
      })
      if (choice === 'cancel') return
      result = await attempt(() => kora.gitResolve(projectId, [path], { deletion: choice }), label)
    }
    if (result?.status === 'has-markers') {
      const ok = await confirm({
        title: `Tem certeza de que deseja marcar "${fileName(path)}" como resolvido com conflitos de mesclagem?`,
        message: 'O arquivo ainda tem marcadores de conflito (<<<<<<< ou >>>>>>>). Se continuar, eles vão para o commit.',
        confirmLabel: 'Marcar mesmo assim',
        danger: true
      })
      if (ok) await attempt(() => kora.gitResolve(projectId, [path], { force: true }), label)
    }
  }

  const stage = async (paths: string[]): Promise<void> => {
    const conflicted = new Set((git.status?.isRepo ? git.status.files : []).filter((f) => f.status === 'conflicted').map((f) => f.path))
    const regular = paths.filter((p) => !conflicted.has(p))
    if (regular.length > 0) await git.run(() => kora.gitStage(projectId, regular), 'Colocando na fila…')
    for (const path of paths.filter((p) => conflicted.has(p))) await resolveOne(path)
  }

  const abort = async (): Promise<void> => {
    if (!operation) return
    const what = { merge: 'o merge', rebase: 'o rebase', 'cherry-pick': 'o cherry-pick', revert: 'o revert' }[operation.kind]
    const ok = await confirm({
      title: `Abortar ${what}?`,
      message: `Os arquivos voltam ao estado de antes d${what}, e as resoluções feitas até aqui se perdem.`,
      confirmLabel: 'Abortar',
      danger: true
    })
    if (ok) await git.run(() => kora.gitAbortOperation(projectId), 'Abortando…')
  }

  const continueOperation = async (): Promise<void> => {
    const message = commitDraft.trim() ? commitDraft : (operation?.message ?? '')
    const result = await attempt(() => kora.gitContinueOperation(projectId, message), 'Concluindo…')
    if (result === 'done' && operation?.kind === 'merge') onCommitDraftChange((current) => (current === commitDraft ? '' : current))
  }

  return {
    push: () => void push(),
    pull: () => void pull(),
    sync: () => void sync(),
    checkout: (name, remote) => void checkout(name, remote),
    stage: (paths) => void stage(paths),
    abort: () => void abort(),
    continueOperation: () => void continueOperation(),
    dialog
  }
}
