import { describe, expect, it } from 'vitest'
import { entryNameProblem, newEntryProblem, parseEntryPath, renameProblem } from '../src/shared/entry-name'

const siblings = [
  { name: 'src', isDir: true },
  { name: 'README.md', isDir: false }
]

describe('nome de arquivo ou pasta', () => {
  it('diz quais caracteres proibidos o nome tem, sem falar de letra de unidade', () => {
    expect(entryNameProblem('a?b')).toMatch(/^O nome não pode conter \? \(proibidos:/)
    expect(entryNameProblem('x:y?z:')).toMatch(/^O nome não pode conter : nem \? \(/)
    expect(entryNameProblem('a<b>c|')).toMatch(/^O nome não pode conter <, > nem \|/)
    expect(entryNameProblem('a\tb')).toMatch(/^O nome não pode conter caracteres de controle/)
    for (const bad of ['x:y', 'a?b']) expect(entryNameProblem(bad), bad).not.toMatch(/unidade/)
  })

  it('recusa vazio, ponto ou espaço no fim e nome de dispositivo; aceita o comum', () => {
    expect(entryNameProblem('  ')).toBe('Nome vazio ou inválido.')
    expect(entryNameProblem('..')).toBe('Nome vazio ou inválido.')
    expect(entryNameProblem('nome.')).toBe('O nome não pode terminar com ponto ou espaço.')
    expect(entryNameProblem('nul.txt')).toBe('"nul.txt" é um nome reservado do Windows.')
    expect(entryNameProblem('.env.local')).toBeNull()
    expect(entryNameProblem(' Relatório final.md ')).toBeNull()
  })

  it('caminho aninhado continua valendo; só "C:\\" e "/" no começo são absolutos', () => {
    expect(parseEntryPath('a/b\\c.ts')).toEqual({ parts: ['a', 'b', 'c.ts'] })
    expect(parseEntryPath('C:\\x.ts')).toEqual({ problem: expect.stringMatching(/letra de unidade/) })
    expect(parseEntryPath('/x.ts')).toEqual({ problem: expect.stringMatching(/barra/) })
    expect(parseEntryPath('c:x.ts')).toEqual({ problem: expect.stringMatching(/não pode conter :/) })
    expect(parseEntryPath('a/../b')).toEqual({ problem: 'O caminho não pode ter "..".' })
    expect(parseEntryPath('ok/con/x')).toEqual({ problem: '"con" é um nome reservado do Windows.' })
  })
})

describe('conferência enquanto digita', () => {
  it('novo item: já existe (sem diferenciar maiúsculas), arquivo no meio do caminho e pasta existente no caminho', () => {
    expect(newEntryProblem('readme.MD', siblings)).toBe('Já existe "README.md" nessa pasta.')
    expect(newEntryProblem('SRC', siblings)).toBe('Já existe "src" nessa pasta.')
    expect(newEntryProblem('README.md/x.ts', siblings)).toBe('"README.md" é um arquivo, não uma pasta.')
    expect(newEntryProblem('src/novo.ts', siblings)).toBeNull()
    expect(newEntryProblem('novo.ts', siblings)).toBeNull()
    expect(newEntryProblem('novo?.ts', siblings)).toMatch(/não pode conter \?/)
  })

  it('renomear: trocar só as maiúsculas vale; o nome de outro item, não; barra é proibida', () => {
    expect(renameProblem('readme.md', 'README.md', siblings)).toBeNull()
    expect(renameProblem('Src', 'README.md', siblings)).toBe('Já existe "src" nessa pasta.')
    expect(renameProblem('a/b', 'README.md', siblings)).toMatch(/não pode conter \//)
    expect(renameProblem('outro.md', 'README.md', siblings)).toBeNull()
  })
})
