import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, MoveConflictError, importEntries, listDir, moveEntry, readText, writeText } from '../src/main/files'

let parent: string
let root: string

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'kora-files-'))
  root = join(parent, 'projeto')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'CLAUDE.md'), '# Regras\n', 'utf8')
  writeFileSync(join(root, 'b.txt'), 'b', 'utf8')
  writeFileSync(join(root, 'src', 'index.ts'), 'x', 'utf8')
  writeFileSync(join(parent, 'segredo.env'), 'TOKEN=123', 'utf8')
})

describe('explorador de arquivos', () => {
  it('lista pastas antes de arquivos e esconde .git', () => {
    expect(listDir(root, '').map((e) => e.name)).toEqual(['src', 'b.txt', 'CLAUDE.md'])
  })

  it('escrita também recusa caminho fora do projeto', () => {
    expect(() => writeText(root, '../segredo.env', 'x', 0)).toThrow(/fora do projeto/)
  })

  it('subpasta devolve caminhos relativos ao projeto', () => {
    expect(listDir(root, 'src')).toEqual([{ name: 'index.ts', path: join('src', 'index.ts'), isDir: false }])
  })

  it('lê o CLAUDE.md do projeto', () => {
    expect(readText(root, 'CLAUDE.md').content).toBe('# Regras\n')
  })

  it('salva quando o arquivo não mudou desde que foi aberto', () => {
    const opened = readText(root, 'b.txt')
    writeText(root, 'b.txt', 'editado', opened.mtimeMs)
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('editado')
  })

  it('recusa salvar por cima de mudança feita no disco depois de abrir (ex.: o Claude editou)', () => {
    const opened = readText(root, 'b.txt')
    writeFileSync(join(root, 'b.txt'), 'mudança do agente', 'utf8')
    utimesSync(join(root, 'b.txt'), new Date(), new Date(Date.now() + 5000))

    expect(() => writeText(root, 'b.txt', 'minha versão', opened.mtimeMs)).toThrow(ConflictError)
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('mudança do agente')
  })

  it('recusa abrir arquivo binário como texto', () => {
    writeFileSync(join(root, 'img.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
    expect(() => readText(root, 'img.bin')).toThrow(/binário/)
  })

  it('recusa ler fora da pasta do projeto', () => {
    expect(() => readText(root, '../segredo.env')).toThrow(/fora do projeto/)
    expect(() => readText(root, join(parent, 'segredo.env'))).toThrow(/fora do projeto/)
    expect(() => listDir(root, '..')).toThrow(/fora do projeto/)
  })

  it('pasta irmã com prefixo igual não passa como se fosse o projeto', () => {
    mkdirSync(join(parent, 'projeto-2'))
    writeFileSync(join(parent, 'projeto-2', 'x.md'), 'x', 'utf8')
    expect(() => readText(root, '../projeto-2/x.md')).toThrow(/fora do projeto/)
  })
})

describe('mover arquivos e pastas', () => {
  it('move arquivo para outra pasta e devolve o caminho no formato do listDir', () => {
    mkdirSync(join(root, 'docs'))

    expect(moveEntry(root, 'b.txt', 'docs')).toBe(join('docs', 'b.txt'))
    expect(existsSync(join(root, 'b.txt'))).toBe(false)
    expect(readFileSync(join(root, 'docs', 'b.txt'), 'utf8')).toBe('b')
  })

  it('move arquivo de subpasta para a raiz', () => {
    expect(moveEntry(root, join('src', 'index.ts'), '')).toBe('index.ts')
    expect(readFileSync(join(root, 'index.ts'), 'utf8')).toBe('x')
    expect(readdirSync(join(root, 'src'))).toEqual([])
  })

  it('move pasta com o conteúdo junto', () => {
    mkdirSync(join(root, 'docs'))
    mkdirSync(join(root, 'src', 'lib'))
    writeFileSync(join(root, 'src', 'lib', 'util.ts'), 'util', 'utf8')

    expect(moveEntry(root, 'src', 'docs')).toBe(join('docs', 'src'))
    expect(existsSync(join(root, 'src'))).toBe(false)
    expect(readFileSync(join(root, 'docs', 'src', 'index.ts'), 'utf8')).toBe('x')
    expect(readFileSync(join(root, 'docs', 'src', 'lib', 'util.ts'), 'utf8')).toBe('util')
  })

  it('mover para a pasta onde já está não faz nada', () => {
    expect(moveEntry(root, join('src', 'index.ts'), 'src')).toBe(join('src', 'index.ts'))
    expect(moveEntry(root, 'b.txt', '')).toBe('b.txt')
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('x')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b')
  })

  it.runIf(process.platform === 'win32')('mesma pasta escrita com outra caixa também é no-op', () => {
    expect(moveEntry(root, join('src', 'index.ts'), 'SRC')).toBe(join('src', 'index.ts'))
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('x')
  })

  it('não sobrescreve arquivo com o mesmo nome no destino', () => {
    writeFileSync(join(root, 'src', 'b.txt'), 'original do destino', 'utf8')

    expect(() => moveEntry(root, 'b.txt', 'src')).toThrow(MoveConflictError)
    expect(readFileSync(join(root, 'src', 'b.txt'), 'utf8')).toBe('original do destino')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b')
  })

  it('não mistura pasta com outra de mesmo nome no destino', () => {
    mkdirSync(join(root, 'docs', 'src'), { recursive: true })

    expect(() => moveEntry(root, 'src', 'docs')).toThrow(MoveConflictError)
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('x')
    expect(readdirSync(join(root, 'docs', 'src'))).toEqual([])
  })

  it('recusa mover pasta para dentro dela mesma ou de uma descendente', () => {
    mkdirSync(join(root, 'src', 'lib', 'fundo'), { recursive: true })

    expect(() => moveEntry(root, 'src', 'src')).toThrow(/dentro dela mesma/)
    expect(() => moveEntry(root, 'src', join('src', 'lib'))).toThrow(/dentro dela mesma/)
    expect(() => moveEntry(root, 'src', join('src', 'lib', 'fundo'))).toThrow(/dentro dela mesma/)
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('x')
  })

  it.runIf(process.platform === 'win32')('descendente escrita com outra caixa também é recusada', () => {
    mkdirSync(join(root, 'src', 'lib'))

    expect(() => moveEntry(root, 'src', join('SRC', 'Lib'))).toThrow(/dentro dela mesma/)
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('x')
  })

  it('pasta irmã com prefixo igual não conta como descendente', () => {
    mkdirSync(join(root, 'docs'))
    mkdirSync(join(root, 'docs-velhos'))
    writeFileSync(join(root, 'docs', 'a.md'), 'a', 'utf8')

    expect(moveEntry(root, 'docs', 'docs-velhos')).toBe(join('docs-velhos', 'docs'))
    expect(readFileSync(join(root, 'docs-velhos', 'docs', 'a.md'), 'utf8')).toBe('a')
  })

  it('recusa origem ou destino fora do projeto', () => {
    mkdirSync(join(parent, 'fora'))

    expect(() => moveEntry(root, '../segredo.env', '')).toThrow(/fora do projeto/)
    expect(() => moveEntry(root, 'b.txt', '..')).toThrow(/fora do projeto/)
    expect(() => moveEntry(root, 'b.txt', '../fora')).toThrow(/fora do projeto/)
    expect(existsSync(join(parent, 'segredo.env'))).toBe(true)
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b')
    expect(readdirSync(join(parent, 'fora'))).toEqual([])
  })

  it('origem que sumiu lança erro com ENOENT', () => {
    let error: unknown
    try {
      moveEntry(root, 'sumiu.txt', 'src')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/^ENOENT/)
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  it('destino que não existe ou não é pasta é recusado', () => {
    expect(() => moveEntry(root, 'b.txt', 'nao-existe')).toThrow(/^ENOENT/)
    expect(() => moveEntry(root, 'b.txt', 'CLAUDE.md')).toThrow(/não é uma pasta/)
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Regras\n')
  })

  it('recusa mover a raiz do projeto', () => {
    mkdirSync(join(root, 'docs'))

    expect(() => moveEntry(root, '', 'docs')).toThrow(/raiz do projeto/)
    expect(() => moveEntry(root, '.', 'docs')).toThrow(/raiz do projeto/)
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true)
  })

  it('recusa mover o .git, algo de dentro dele ou para dentro dele', () => {
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')

    expect(() => moveEntry(root, '.git', 'src')).toThrow(/\.git/)
    expect(() => moveEntry(root, join('.git', 'HEAD'), '')).toThrow(/\.git/)
    expect(() => moveEntry(root, 'b.txt', '.git')).toThrow(/\.git/)
    expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(root, 'src', '.git'))).toBe(false)
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b')
  })

  it.runIf(process.platform === 'win32')('.git escrito com outra caixa também é recusado', () => {
    expect(() => moveEntry(root, '.GIT', 'src')).toThrow(/\.git/)
    expect(existsSync(join(root, '.git'))).toBe(true)
  })
})

describe('copiar para o projeto o que veio do Explorer do Windows', () => {
  let fora: string
  beforeEach(() => {
    fora = join(parent, 'fora')
    mkdirSync(join(fora, 'fotos', 'viagem'), { recursive: true })
    writeFileSync(join(fora, 'relatório.pdf'), 'pdf', 'utf8')
    writeFileSync(join(fora, 'fotos', 'a.png'), 'a', 'utf8')
    writeFileSync(join(fora, 'fotos', 'viagem', 'b.png'), 'b', 'utf8')
  })

  it('copia arquivo para a pasta e mantém o original onde estava', () => {
    expect(importEntries(root, [join(fora, 'relatório.pdf')], 'src')).toEqual([join('src', 'relatório.pdf')])
    expect(readFileSync(join(root, 'src', 'relatório.pdf'), 'utf8')).toBe('pdf')
    expect(existsSync(join(fora, 'relatório.pdf'))).toBe(true)
  })

  it('copia pasta inteira, com subpastas, para a raiz do projeto', () => {
    expect(importEntries(root, [join(fora, 'fotos')], '')).toEqual(['fotos'])
    expect(readFileSync(join(root, 'fotos', 'viagem', 'b.png'), 'utf8')).toBe('b')
    expect(existsSync(join(fora, 'fotos', 'viagem', 'b.png'))).toBe(true)
  })

  it('nome que já existe ganha (2), (3)... e nada é sobrescrito', () => {
    writeFileSync(join(fora, 'b.txt'), 'de fora', 'utf8')
    expect(importEntries(root, [join(fora, 'b.txt')], '')).toEqual(['b (2).txt'])
    expect(importEntries(root, [join(fora, 'b.txt')], '')).toEqual(['b (3).txt'])
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b')
    mkdirSync(join(root, 'fotos'))
    expect(importEntries(root, [join(fora, 'fotos')], '')).toEqual(['fotos (2)'])
  })

  it('vários itens de uma vez', () => {
    expect(importEntries(root, [join(fora, 'relatório.pdf'), join(fora, 'fotos')], 'src')).toEqual([
      join('src', 'relatório.pdf'),
      join('src', 'fotos')
    ])
  })

  it('item que já está na pasta de destino não é duplicado', () => {
    expect(importEntries(root, [join(root, 'src', 'index.ts')], 'src')).toEqual([])
    expect(readdirSync(join(root, 'src'))).toEqual(['index.ts'])
  })

  it('recusa destino dentro do .git, fora do projeto ou pasta copiada para dentro dela mesma', () => {
    expect(() => importEntries(root, [join(fora, 'relatório.pdf')], '.git')).toThrow(/\.git/)
    expect(() => importEntries(root, [join(fora, 'relatório.pdf')], '..')).toThrow(/fora do projeto/)
    expect(() => importEntries(root, [root], 'src')).toThrow(/dentro dela mesma/)
    expect(existsSync(join(root, '.git', 'relatório.pdf'))).toBe(false)
  })

  it('item arrastado que sumiu antes de soltar vira erro legível', () => {
    expect(() => importEntries(root, [join(fora, 'nao-existe.txt')], '')).toThrow(/não existe/)
  })
})
