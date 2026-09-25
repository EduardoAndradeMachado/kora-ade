import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Notas da Release montadas dos títulos dos commits (Conventional Commits) entre a tag anterior e a nova.
// Só entra o que muda para quem usa o app; chore, test, ci, docs, refactor e build ficam no link de comparação.
const SECTIONS = [
  { type: 'feat', title: 'Novidades' },
  { type: 'fix', title: 'Correções' },
  { type: 'perf', title: 'Desempenho' }
] as const

const SUBJECT = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/

export interface NotesInput {
  tag: string
  previousTag: string | null
  subjects: string[]
  repo: string
}

export function releaseNotes({ tag, previousTag, subjects, repo }: NotesInput): string {
  if (!previousTag) return 'Primeira versão publicada.\n'
  const parts: string[] = []
  for (const { type, title } of SECTIONS) {
    const items = subjects.flatMap((subject) => {
      const match = SUBJECT.exec(subject.trim())
      if (!match || match[1] !== type) return []
      const text = match[2]!
      return [`- ${text.charAt(0).toUpperCase()}${text.slice(1)}`]
    })
    if (items.length > 0) parts.push(`## ${title}\n\n${items.join('\n')}`)
  }
  if (parts.length === 0) parts.push('Só manutenção interna, sem mudança visível no app.')
  parts.push(`**Todos os commits:** https://github.com/${repo}/compare/${previousTag}...${tag}`)
  return parts.join('\n\n') + '\n'
}

const versionParts = (tag: string): number[] => tag.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)

function compareVersions(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// A maior versão abaixo da tag, entre as tags alcançáveis a partir dela.
export function previousTagOf(tag: string, reachableTags: string[]): string | null {
  const older = reachableTags.filter((t) => /^v\d/.test(t) && compareVersions(t, tag) < 0)
  older.sort(compareVersions)
  return older.at(-1) ?? null
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

// node scripts/release-notes.ts v0.1.9 [dono/repositorio]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2]
  const repo = process.argv[3] ?? process.env['GITHUB_REPOSITORY']
  if (!tag || !repo) throw new Error('uso: node scripts/release-notes.ts <tag> [dono/repositorio]')
  const previousTag = previousTagOf(tag, git('tag', '--merged', tag).split('\n'))
  const subjects = previousTag ? git('log', '--reverse', '--format=%s', `${previousTag}..${tag}`).split('\n') : []
  process.stdout.write(releaseNotes({ tag, previousTag, subjects, repo }))
}
