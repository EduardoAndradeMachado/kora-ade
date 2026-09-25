import { describe, expect, it } from 'vitest'
import { previousTagOf, releaseNotes } from '../scripts/release-notes'

const repo = 'EduardoAndradeMachado/kora-ade'

describe('notas da Release pelos commits', () => {
  it('agrupa novidades e correções na ordem dos commits e deixa manutenção só no link', () => {
    const notes = releaseNotes({
      tag: 'v0.1.9',
      previousTag: 'v0.1.8',
      repo,
      subjects: [
        'feat: caminho no topo do arquivo copia com um clique e pode ser editado',
        'fix: Claude com subagente em segundo plano conta como esperando você',
        'fix(codex): aba do Codex não fica presa na conversa do subagente',
        'test: app dos testes abre fora da tela e sem tirar o foco',
        'chore: prepara a versão 0.1.9'
      ]
    })
    expect(notes).toBe(
      [
        '## Novidades',
        '',
        '- Caminho no topo do arquivo copia com um clique e pode ser editado',
        '',
        '## Correções',
        '',
        '- Claude com subagente em segundo plano conta como esperando você',
        '- Aba do Codex não fica presa na conversa do subagente',
        '',
        `**Todos os commits:** https://github.com/${repo}/compare/v0.1.8...v0.1.9`,
        ''
      ].join('\n')
    )
  })

  it('versão só com manutenção avisa que não muda nada no app', () => {
    const notes = releaseNotes({ tag: 'v0.2.1', previousTag: 'v0.2.0', repo, subjects: ['ci: cache do pnpm', 'chore: prepara a versão 0.2.1'] })
    expect(notes).toContain('Só manutenção interna')
    expect(notes).not.toContain('##')
  })

  it('primeira versão não tem com o que comparar', () => {
    expect(releaseNotes({ tag: 'v0.1.1', previousTag: null, repo, subjects: [] })).toBe('Primeira versão publicada.\n')
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
