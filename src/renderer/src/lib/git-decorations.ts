import type { GitFile, GitFileStatus } from '@shared/git-types'

// Mesmas cores do VS Code: claras no tema escuro, escuras no claro para manter contraste.
export const GIT_STYLE: Record<GitFileStatus, { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-[#895503] dark:text-[#e2c08d]' },
  added: { letter: 'A', className: 'text-[#587c0c] dark:text-[#73c991]' },
  untracked: { letter: 'U', className: 'text-[#587c0c] dark:text-[#73c991]' },
  renamed: { letter: 'R', className: 'text-[#007acc] dark:text-[#73c991]' },
  deleted: { letter: 'D', className: 'text-[#ad0707] dark:text-[#f48771]' },
  conflicted: { letter: '!', className: 'text-[#ad0707] dark:text-[#e06c75]' }
}

export const gitPathKey = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

// Status de cada arquivo e o que cada pasta herda dos arquivos de dentro dela.
export function gitMaps(gitFiles: GitFile[]): { files: Map<string, GitFileStatus>; dirs: Map<string, GitFileStatus> } {
  const files = new Map<string, GitFileStatus>()
  const dirs = new Map<string, GitFileStatus>()
  for (const f of gitFiles) {
    files.set(gitPathKey(f.path), f.status)
    const parts = gitPathKey(f.path).split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      // Conflito vence qualquer outro status na pasta; depois, modificado.
      const current = dirs.get(dir)
      if (current !== 'conflicted' && (f.status === 'conflicted' || !current || current === 'untracked')) {
        dirs.set(dir, f.status === 'untracked' || f.status === 'added' ? (current ?? f.status) : f.status)
      }
    }
  }
  return { files, dirs }
}
