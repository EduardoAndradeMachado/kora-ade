import { describe, expect, it } from 'vitest'
import { previousTagOf, releaseNotes, type Commit } from '../scripts/release-notes'

const repo = 'EduardoAndradeMachado/kora-ade'
const commit = (n: number, subject: string): Commit => ({ sha: `${n}`.repeat(40).slice(0, 40), subject })
const link = (n: number): string => {
  const sha = `${n}`.repeat(40).slice(0, 40)
  return `[\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha})`
}

describe('notas da Release pelos commits', () => {
  it('destaca novidades e correções com o link de cada commit; a lista completa fica recolhida', () => {
    const notes = releaseNotes({
      tag: 'v0.1.9',
      previousTag: 'v0.1.8',
      repo,
      commits: [
        commit(1, 'feat: caminho no topo do arquivo copia com um clique e pode ser editado'),
        commit(2, 'fix: Claude com subagente em segundo plano conta como esperando você'),
        commit(3, 'fix(codex): aba do Codex não fica presa na conversa do subagente'),
        commit(4, 'test: app dos testes abre fora da tela e sem tirar o foco'),
        commit(5, 'chore: prepara a versão 0.1.9')
      ]
    })
    expect(notes).toBe(
      [
        '## Novidades',
        '',
        `- Caminho no topo do arquivo copia com um clique e pode ser editado (${link(1)})`,
        '',
        '## Correções',
        '',
        `- Claude com subagente em segundo plano conta como esperando você (${link(2)})`,
        `- Aba do Codex não fica presa na conversa do subagente (${link(3)})`,
        '',
        '<details>',
        '<summary>Todos os commits (5)</summary>',
        '',
        `- ${link(1)} feat: caminho no topo do arquivo copia com um clique e pode ser editado`,
        `- ${link(2)} fix: Claude com subagente em segundo plano conta como esperando você`,
        `- ${link(3)} fix(codex): aba do Codex não fica presa na conversa do subagente`,
        `- ${link(4)} test: app dos testes abre fora da tela e sem tirar o foco`,
        `- ${link(5)} chore: prepara a versão 0.1.9`,
        '',
        `Comparação completa: https://github.com/${repo}/compare/v0.1.8...v0.1.9`,
        '',
        '</details>',
        ''
      ].join('\n')
    )
  })

  it('versão só com manutenção avisa que não muda nada no app e ainda lista os commits', () => {
    const notes = releaseNotes({
      tag: 'v0.2.1',
      previousTag: 'v0.2.0',
      repo,
      commits: [commit(6, 'ci: cache do pnpm'), commit(7, 'chore: prepara a versão 0.2.1')]
    })
    expect(notes).toContain('Só manutenção interna')
    expect(notes).not.toContain('##')
    expect(notes).toContain(`- ${link(6)} ci: cache do pnpm`)
    expect(notes).toContain('Todos os commits (2)')
  })

  it('primeira versão não tem com o que comparar', () => {
    expect(releaseNotes({ tag: 'v0.1.1', previousTag: null, repo, commits: [] })).toBe('Primeira versão publicada.\n')
  })
})

describe('tag anterior', () => {
  it('compara como versão, não como texto: 0.1.10 vem depois de 0.1.9', () => {
    expect(previousTagOf('v0.1.10', ['v0.1.2', 'v0.1.9', 'v0.1.10', 'v0.1.1'])).toBe('v0.1.9')
    expect(previousTagOf('v0.2.0', ['v0.1.10', 'v0.1.9', 'v0.2.0'])).toBe('v0.1.10')
  })

  it('primeira tag não tem anterior; tags fora do padrão são ignoradas', () => {
    expect(previousTagOf('v0.1.1', ['v0.1.1', 'rascunho'])).toBeNull()
  })
})
