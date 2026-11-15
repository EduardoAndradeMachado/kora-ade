export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

// Par XY do porcelain para arquivo não mesclado. "Nós" é o HEAD; "eles", o que está entrando.
// DU: apagado por nós e modificado por eles; UD: o contrário; AU/UA: só um lado adicionou; DD: os dois apagaram.
export type GitConflictCode = 'DD' | 'AU' | 'UD' | 'UA' | 'DU' | 'AA' | 'UU'

export interface GitFile {
  // Relativo à raiz do projeto e com o separador do SO, igual ao `path` de FileEntry.
  path: string
  status: GitFileStatus
  staged: boolean
  origPath?: string
  conflict?: GitConflictCode
}

export type GitOperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface GitOperation {
  kind: GitOperationKind
  // A mensagem que o git preparou para o commit (MERGE_MSG), sem as linhas de comentário.
  message?: string
  // Rebase: branch sendo rebaseada e o passo atual de quantos.
  head?: string
  step?: number
  total?: number
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  detached: boolean
  oid: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
  operation?: GitOperation | null
  stashCount?: number
}

// O erro do git chega ao renderer só como texto: a primeira parte é a explicação em português, o que vem depois
// deste separador é a saída original do git, mostrada recolhida em "Detalhes".
export const GIT_ERROR_DETAIL = '\n\nDetalhes do git:\n'

// 'conflicts': a ação parou com arquivos em conflito (o painel mostra o merge/rebase em andamento).
export type GitPullResult =
  | { status: 'ok' }
  | { status: 'conflicts' }
  | { status: 'diverged'; ahead: number; behind: number; upstream: string }

export type GitPullStrategy = 'default' | 'merge' | 'rebase'

// stash: guarda as alterações (com não rastreados) e troca. migrate: guarda, troca e reaplica, como o "Migrar
// alterações" do VS Code. force: troca descartando as alterações locais.
export type GitCheckoutMode = 'normal' | 'stash' | 'migrate' | 'force'

export type GitCheckoutResult =
  | { status: 'ok' }
  | { status: 'conflicts' }
  // Caminhos como o git lista (relativos à raiz do repositório, com "/").
  | { status: 'local-changes'; files: string[] }

export type GitResolveResult =
  | { status: 'resolved' }
  | { status: 'has-markers'; paths: string[] }
  | { status: 'needs-choice'; path: string; conflict: GitConflictCode }

export type GitDeletionChoice = 'keep' | 'delete'

export interface GitStash {
  index: number
  // Confere que `stash@{index}` ainda é o mesmo stash na hora de aplicar ou remover.
  oid: string
  message: string
  branch: string | null
  relative: string
}

export interface GitStashRef {
  index: number
  oid: string
}

export interface GitStashFile {
  status: string
  path: string
}

export type GitContinueResult = 'done' | 'conflicts'

// O remoto tem commits que só faltam aqui porque o histórico local foi reescrito (corrigir ou desfazer um commit já
// enviado): `lost` são os que o push forçado apagaria do remoto, `remoteOid` é o lease do --force-with-lease.
export interface GitPushRewritten {
  status: 'rewritten'
  upstream: string
  remoteOid: string
  lost: { hash: string; subject: string }[]
}

export type GitPushResult = { status: 'ok' } | GitPushRewritten

export interface GitBranch {
  // Local: "main". Remota: "origin/main", com `remote` = "origin".
  name: string
  remote: string | null
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  lastCommit?: { subject: string; relative: string }
}

export interface GitWorktree {
  path: string
  branch: string | null
  head: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
  current: boolean
}

export type GitCommitResult = 'committed' | 'nothing-staged'

// Os dois lados do diff de um arquivo. Não staged: index → disco. Staged: HEAD → index. De um commit: pai → commit.
// Lado que não existe (arquivo novo, apagado) vem vazio; binário vem sem conteúdo.
export interface GitDiff {
  original: string
  modified: string
  binary: boolean
}

// `current`: a branch para onde o HEAD aponta. `head`: HEAD destacado neste commit.
export interface GitRef {
  name: string
  kind: 'branch' | 'remote' | 'tag' | 'head'
  current?: boolean
}

export interface GitLogCommit {
  hash: string
  parents: string[]
  author: string
  email: string
  // Data do autor, em segundos Unix.
  date: number
  relative: string
  subject: string
  body: string
  refs: GitRef[]
}

export interface GitLogPage {
  commits: GitLogCommit[]
  hasMore: boolean
}

// Arquivo alterado num commit, comparado com o primeiro pai (o commit inicial, com o vazio).
export interface GitCommitFile {
  path: string
  status: GitFileStatus
  origPath?: string
}

export interface GitHeadCommit {
  hash: string
  message: string
  // Primeiro commit do repositório: não há pai para onde voltar.
  isRoot: boolean
  // Já está em alguma branch remota conhecida (desde o último fetch): reescrever exige force push.
  pushed: boolean
}

export type GitBranchDeleteResult = 'deleted' | 'not-merged'

// Bloco de `git diff -U0`. `id` identifica o conteúdo: aplicar confere que o trecho ainda é o mesmo.
export interface GitHunk {
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

// stage e discard valem para o diff fila ↔ disco; unstage, para HEAD ↔ fila.
export type GitHunkAction = 'stage' | 'unstage' | 'discard'
