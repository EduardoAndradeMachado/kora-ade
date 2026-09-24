export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export interface GitFile {
  // Relativo à raiz do projeto e com o separador do SO, igual ao `path` de FileEntry.
  path: string
  status: GitFileStatus
  staged: boolean
  origPath?: string
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
}

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
