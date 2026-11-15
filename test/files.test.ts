import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, MoveConflictError, copyInto, copyItem, importEntries, listDir, moveEntry, readText, resolveInside, writeText } from '../src/main/files'

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

describe('raiz do projeto', () => {
  it('link (junção) dentro do projeto apontando para fora não abre caminho para fora: nem ler, nem listar, nem criar', () => {
    mkdirSync(join(parent, 'fora'))
    writeFileSync(join(parent, 'fora', 'id_rsa'), 'CHAVE', 'utf8')
    // Junção não pede administrador no Windows; um repositório clonado pode trazer um link assim.
    symlinkSync(join(parent, 'fora'), join(root, 'atalho'), 'junction')
    expect(() => readText(root, 'atalho/id_rsa')).toThrow('fora do projeto')
    expect(() => listDir(root, 'atalho')).toThrow('fora do projeto')
    expect(() => resolveInside(root, 'atalho/novo.txt')).toThrow('fora do projeto')
    expect(resolveInside(root, 'src/novo.ts')).toBe(join(root, 'src', 'novo.ts'))
    expect(readText(root, 'src/index.ts').content).toBe('x')
  })
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

  it('copia arquivo para a pasta e mantém o original onde estava', async () => {
    expect(await importEntries(root, [join(fora, 'relatório.pdf')], 'src')).toEqual([join('src', 'relatório.pdf')])
    expect(readFileSync(join(root, 'src', 'relatório.pdf'), 'utf8')).toBe('pdf')
    expect(existsSync(join(fora, 'relatório.pdf'))).toBe(true)
  })

  it('copia pasta inteira, com subpastas, para a raiz do projeto', async () => {
    expect(await importEntries(root, [join(fora, 'fotos')], '')).toEqual(['fotos'])
    expect(readFileSync(join(root, 'fotos', 'viagem', 'b.png'), 'utf8')).toBe('b')
    expect(existsSync(join(fora, 'fotos', 'viagem', 'b.png'))).toBe(true)
  })

  it('nome que já existe ganha (2), (3)... e nada é sobrescrito', async () => {
    writeFileSync(join(fora, 'b.txt'), 'de fora', 'utf8')
    expect(await importEntries(root, [join(fora, 'b.txt')], '')).toEqual(['b (2).txt'])
    expect(await importEntries(root, [join(fora, 'b.txt')], '')).toEqual(['b (3).txt'])
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b')
    mkdirSync(join(root, 'fotos'))
    expect(await importEntries(root, [join(fora, 'fotos')], '')).toEqual(['fotos (2)'])
    expect(readdirSync(join(root, 'fotos'))).toEqual([])
    expect(readFileSync(join(root, 'fotos (2)', 'viagem', 'b.png'), 'utf8')).toBe('b')
  })

  it('vários itens de uma vez', async () => {
    expect(await importEntries(root, [join(fora, 'relatório.pdf'), join(fora, 'fotos')], 'src')).toEqual([
      join('src', 'relatório.pdf'),
      join('src', 'fotos')
    ])
  })

  it('item que já está na pasta de destino não é duplicado', async () => {
    expect(await importEntries(root, [join(root, 'src', 'index.ts')], 'src')).toEqual([])
    expect(readdirSync(join(root, 'src'))).toEqual(['index.ts'])
  })

  it('recusa destino dentro do .git, fora do projeto ou pasta copiada para dentro dela mesma', async () => {
    await expect(importEntries(root, [join(fora, 'relatório.pdf')], '.git')).rejects.toThrow(/\.git/)
    await expect(importEntries(root, [join(fora, 'relatório.pdf')], '..')).rejects.toThrow(/fora do projeto/)
    await expect(importEntries(root, [root], 'src')).rejects.toThrow(/dentro dela mesma/)
    expect(existsSync(join(root, '.git', 'relatório.pdf'))).toBe(false)
  })

  it('item arrastado que sumiu antes de soltar vira erro legível', async () => {
    await expect(importEntries(root, [join(fora, 'nao-existe.txt')], '')).rejects.toThrow(/não existe/)
  })

  it('falha no meio da cópia apaga o que já tinha sido copiado e não toca no que existia', async () => {
    const before = readdirSync(join(root, 'src')).sort()
    let calls = 0
    const copyFailingOnSecond = async (source: string, target: string): Promise<void> => {
      calls++
      await copyItem(source, target)
      if (calls === 2) throw Object.assign(new Error('EBUSY: arquivo travado'), { code: 'EBUSY' })
    }

    await expect(copyInto(root, [join(fora, 'relatório.pdf'), join(fora, 'fotos')], 'src', 'skip', copyFailingOnSecond)).rejects.toThrow(/EBUSY/)
    expect(readdirSync(join(root, 'src')).sort()).toEqual(before)
    expect(existsSync(join(fora, 'fotos', 'viagem', 'b.png'))).toBe(true)
  })

  it('falha no meio da cópia não apaga a cópia que um agente já alterou, avisa que ela ficou e apaga só o resto', async () => {
    writeFileSync(join(fora, 'c.txt'), 'c', 'utf8')
    let calls = 0
    const agentEditsThenThirdFails = async (source: string, target: string): Promise<void> => {
      calls++
      if (calls === 3) {
        writeFileSync(join(root, 'src', 'fotos', 'viagem', 'b.png'), 'trabalho do agente', 'utf8')
        throw Object.assign(new Error('ENOENT: sumiu'), { code: 'ENOENT' })
      }
      await copyItem(source, target)
    }

    await expect(
      copyInto(root, [join(fora, 'fotos'), join(fora, 'relatório.pdf'), join(fora, 'c.txt')], 'src', 'skip', agentEditsThenThirdFails)
    ).rejects.toThrow(/ENOENT[\s\S]*fotos/)
    expect(readFileSync(join(root, 'src', 'fotos', 'viagem', 'b.png'), 'utf8')).toBe('trabalho do agente')
    expect(existsSync(join(root, 'src', 'relatório.pdf'))).toBe(false)
    expect(existsSync(join(root, 'src', 'c.txt'))).toBe(false)
  })
})

describe('codificação do texto', () => {
  const bom8 = Buffer.from([0xef, 0xbb, 0xbf])
  const utf16le = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const utf16be = (text: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
  const disk = (name: string): Buffer => readFileSync(join(root, name))
  const saveEdited = (name: string, content: string): void => {
    writeText(root, name, content, readText(root, name).mtimeMs)
  }

  it('UTF-8 sem BOM continua sem BOM depois de salvar', () => {
    writeFileSync(join(root, 'a.txt'), 'olá\n', 'utf8')
    expect(readText(root, 'a.txt')).toMatchObject({ content: 'olá\n', encoding: 'UTF-8', eol: 'LF' })
    saveEdited('a.txt', 'ação\n')
    expect(disk('a.txt')).toEqual(Buffer.from('ação\n', 'utf8'))
  })

  it('UTF-8 com BOM mantém o BOM, mesmo se o texto salvo vier sem ele, e não duplica', () => {
    writeFileSync(join(root, 'a.txt'), Buffer.concat([bom8, Buffer.from('café', 'utf8')]))
    expect(readText(root, 'a.txt')).toMatchObject({ content: '﻿café', encoding: 'UTF-8 com BOM' })
    saveEdited('a.txt', 'chá')
    expect(disk('a.txt')).toEqual(Buffer.concat([bom8, Buffer.from('chá', 'utf8')]))
    saveEdited('a.txt', '﻿pão')
    expect(disk('a.txt')).toEqual(Buffer.concat([bom8, Buffer.from('pão', 'utf8')]))
  })

  it('UTF-16 LE abre como texto (não binário) e salva em UTF-16 LE com BOM', () => {
    writeFileSync(join(root, 'reg.txt'), utf16le('ação\r\nlinha 2\r\n'))
    expect(readText(root, 'reg.txt')).toMatchObject({ content: '﻿ação\r\nlinha 2\r\n', encoding: 'UTF-16 LE', eol: 'CRLF' })
    saveEdited('reg.txt', '﻿editado ç\r\n')
    expect(disk('reg.txt')).toEqual(utf16le('editado ç\r\n'))
  })

  it('UTF-16 BE abre como texto e salva em UTF-16 BE com BOM', () => {
    writeFileSync(join(root, 'be.txt'), utf16be('ação'))
    expect(readText(root, 'be.txt')).toMatchObject({ content: '﻿ação', encoding: 'UTF-16 BE' })
    saveEdited('be.txt', '﻿mudou é')
    expect(disk('be.txt')).toEqual(utf16be('mudou é'))
  })

  it('Windows-1252 abre com os acentos certos e salva em Windows-1252', () => {
    // "café €" em Windows-1252: é = E9, € = 80 (não é UTF-8 válido).
    writeFileSync(join(root, 'velho.bat'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]))
    expect(readText(root, 'velho.bat')).toMatchObject({ content: 'café €', encoding: 'Windows-1252' })
    saveEdited('velho.bat', 'ação €“”')
    expect(disk('velho.bat')).toEqual(Buffer.from([0x61, 0xe7, 0xe3, 0x6f, 0x20, 0x80, 0x93, 0x94]))
  })

  it('Windows-1252: todo byte decodifica como o TextDecoder e volta igual ao salvar sem mudar nada', () => {
    const bytes = Buffer.from(Array.from({ length: 255 }, (_, i) => i + 1))
    writeFileSync(join(root, 'todos.txt'), bytes)
    const opened = readText(root, 'todos.txt')
    expect(opened.content).toBe(new TextDecoder('windows-1252').decode(bytes))
    writeText(root, 'todos.txt', opened.content, opened.mtimeMs)
    expect(disk('todos.txt')).toEqual(bytes)
  })

  it('Windows-1252: um salvamento intermediário só com ASCII não troca a codificação do seguinte', () => {
    writeFileSync(join(root, 'velho.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    const opened = readText(root, 'velho.txt')
    const ascii = writeText(root, 'velho.txt', 'cafe', opened.mtimeMs, opened.encodingId)
    writeText(root, 'velho.txt', 'café', ascii, opened.encodingId)
    expect(disk('velho.txt')).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  })

  it('a pista de codificação não vence o que o disco já mostra (UTF-8 com acento continua UTF-8)', () => {
    writeFileSync(join(root, 'novo.txt'), 'ação', 'utf8')
    const opened = readText(root, 'novo.txt')
    writeText(root, 'novo.txt', 'ação!', opened.mtimeMs, 'cp1252')
    expect(disk('novo.txt').toString('utf8')).toBe('ação!')
  })

  it('Windows-1252: caractere que não existe nela recusa salvar e não mexe no disco', () => {
    const original = Buffer.from([0x63, 0x61, 0x66, 0xe9])
    writeFileSync(join(root, 'velho.txt'), original)
    const opened = readText(root, 'velho.txt')
    expect(() => writeText(root, 'velho.txt', 'café\nok ✓', opened.mtimeMs)).toThrow(/Windows-1252.*"✓" \(linha 2\)/)
    expect(disk('velho.txt')).toEqual(original)
  })

  describe('codificação escolhida pelo usuário (Reabrir/Salvar com codificação)', () => {
    const forced = (name: string, encoding: string): ReturnType<typeof readText> => readText(root, name, { encoding })
    const saveWith = (name: string, content: string, encoding: string): void => {
      writeText(root, name, content, readText(root, name).mtimeMs, encoding, { forceEncoding: true })
    }

    it('cada codificação grava os bytes dela e reabre com o mesmo texto', () => {
      const bytesOf: Record<string, Buffer> = {
        utf8: Buffer.from('ação', 'utf8'),
        utf8bom: Buffer.concat([bom8, Buffer.from('ação', 'utf8')]),
        utf16le: utf16le('ação'),
        utf16be: utf16be('ação'),
        cp1252: Buffer.from([0x61, 0xe7, 0xe3, 0x6f]),
        latin1: Buffer.from([0x61, 0xe7, 0xe3, 0x6f])
      }
      for (const [id, bytes] of Object.entries(bytesOf)) {
        writeFileSync(join(root, 'x.txt'), 'inicial', 'utf8')
        saveWith('x.txt', 'ação', id)
        expect(disk('x.txt'), id).toEqual(bytes)
        expect(forced('x.txt', id).content.replace(/^﻿/, ''), id).toBe('ação')
        expect(forced('x.txt', id).encodingId, id).toBe(id)
      }
    })

    it('Windows-1252 e ISO-8859-1 diferem em 0x80–0x9F, e o € não existe no ISO-8859-1', () => {
      writeFileSync(join(root, 'x.txt'), Buffer.from([0x80, 0x93]))
      expect(forced('x.txt', 'cp1252').content).toBe('€“')
      expect(forced('x.txt', 'latin1')).toMatchObject({ content: '\x80\x93', encoding: 'ISO-8859-1' })
      expect(() => saveWith('x.txt', 'preço: 5 €', 'latin1')).toThrow(/ISO-8859-1.*"€" \(linha 1\)/)
      expect(disk('x.txt')).toEqual(Buffer.from([0x80, 0x93]))
    })

    it('UTF-8 com um byte inválido abre como Windows-1252; reabrir como UTF-8 e salvar grava UTF-8, não 1252', () => {
      const original = Buffer.concat([Buffer.from('ação ', 'utf8'), Buffer.from([0xff])])
      writeFileSync(join(root, 'quase.txt'), original)
      expect(readText(root, 'quase.txt')).toMatchObject({ encodingId: 'cp1252', content: 'aÃ§Ã£o ÿ' })
      const reopened = forced('quase.txt', 'utf8')
      expect(reopened).toMatchObject({ encodingId: 'utf8', encoding: 'UTF-8', content: 'ação �' })
      writeText(root, 'quase.txt', 'ação ok', reopened.mtimeMs, reopened.encodingId, { forceEncoding: true })
      expect(disk('quase.txt')).toEqual(Buffer.from('ação ok', 'utf8'))
    })

    it('Windows-1252 reaberto como UTF-8 mostra o caractere de substituição sem mexer no disco', () => {
      const original = Buffer.from([0x63, 0x61, 0x66, 0xe9])
      writeFileSync(join(root, 'velho.txt'), original)
      expect(forced('velho.txt', 'utf8').content).toBe('caf�')
      expect(disk('velho.txt')).toEqual(original)
    })

    it('salvar com outra codificação troca os bytes no disco e os salvamentos seguintes continuam nela', () => {
      writeFileSync(join(root, 'a.txt'), 'ação', 'utf8')
      saveWith('a.txt', 'ação', 'cp1252')
      expect(disk('a.txt')).toEqual(Buffer.from([0x61, 0xe7, 0xe3, 0x6f]))
      const next = readText(root, 'a.txt')
      expect(next.encodingId).toBe('cp1252')
      writeText(root, 'a.txt', 'ação!', next.mtimeMs, next.encodingId)
      expect(disk('a.txt')).toEqual(Buffer.from([0x61, 0xe7, 0xe3, 0x6f, 0x21]))
    })

    it('UTF-8 com BOM salvo como UTF-8 perde o BOM; UTF-8 salvo com BOM ganha', () => {
      writeFileSync(join(root, 'a.txt'), Buffer.concat([bom8, Buffer.from('café', 'utf8')]))
      saveWith('a.txt', readText(root, 'a.txt').content, 'utf8')
      expect(disk('a.txt')).toEqual(Buffer.from('café', 'utf8'))
      saveWith('a.txt', 'café', 'utf8bom')
      expect(disk('a.txt')).toEqual(Buffer.concat([bom8, Buffer.from('café', 'utf8')]))
      expect(forced('a.txt', 'utf8').content).toBe('café')
    })

    it('UTF-16 escolhido para arquivo sem BOM decodifica todos os bytes; com tamanho ímpar recusa', () => {
      writeFileSync(join(root, 'sem-bom.txt'), Buffer.from('oi', 'utf16le'))
      expect(forced('sem-bom.txt', 'utf16le').content).toBe('﻿oi')
      writeFileSync(join(root, 'impar.txt'), Buffer.from([0x61, 0x00, 0x62]))
      expect(() => forced('impar.txt', 'utf16le')).toThrow(/ímpar/)
    })

    it('codificação desconhecida é recusada em vez de cair na detecção', () => {
      expect(() => forced('b.txt', 'shift-jis')).toThrow(/desconhecida/)
      const opened = readText(root, 'b.txt')
      expect(() => writeText(root, 'b.txt', 'x', opened.mtimeMs, 'shift-jis', { forceEncoding: true })).toThrow(/desconhecida/)
      expect(disk('b.txt').toString('utf8')).toBe('b')
    })

    it('a escolha continua respeitando o arquivo mudado no disco depois de aberto', () => {
      const opened = readText(root, 'b.txt')
      utimesSync(join(root, 'b.txt'), new Date(), new Date(Date.now() + 5000))
      expect(() => writeText(root, 'b.txt', 'x', opened.mtimeMs, 'utf16le', { forceEncoding: true })).toThrow(ConflictError)
      expect(disk('b.txt').toString('utf8')).toBe('b')
    })
  })

  it('binário de verdade continua recusado, inclusive começando como UTF-16 mas com tamanho ímpar', () => {
    writeFileSync(join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))
    writeFileSync(join(root, 'falso.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]))
    expect(() => readText(root, 'a.png')).toThrow(/binário/)
    expect(() => readText(root, 'falso.bin')).toThrow(/binário/)
  })
})

describe('arquivo grande', () => {
  it('acima de 5 MB pede confirmação; com force abre; acima de 50 MB nem com force', () => {
    writeFileSync(join(root, 'log.txt'), Buffer.alloc(6 * 1024 * 1024, 'a'))
    expect(() => readText(root, 'log.txt')).toThrow(/^Arquivo grande demais/)
    expect(readText(root, 'log.txt', { force: true }).content).toHaveLength(6 * 1024 * 1024)

    writeFileSync(join(root, 'dump.txt'), Buffer.alloc(51 * 1024 * 1024, 'a'))
    expect(() => readText(root, 'dump.txt', { force: true })).toThrow(/^Arquivo acima de 50 MB/)
  })
})

describe('arquivo apagado ou movido com a aba aberta', () => {
  it('salvar recria o arquivo, sem checar o mtime antigo', () => {
    const opened = readText(root, 'b.txt')
    rmSync(join(root, 'b.txt'))
    writeText(root, 'b.txt', 'de volta', opened.mtimeMs, opened.encodingId, { recreate: true })
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('de volta')
  })

  it('sem pedir recriação (celular) continua dando ENOENT e não cria nada', () => {
    const opened = readText(root, 'b.txt')
    rmSync(join(root, 'b.txt'))
    expect(() => writeText(root, 'b.txt', 'de volta', opened.mtimeMs)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(existsSync(join(root, 'b.txt'))).toBe(false)
  })

  it('recria a pasta também, se ela sumiu junto', () => {
    const opened = readText(root, 'src/index.ts')
    rmSync(join(root, 'src'), { recursive: true })
    writeText(root, 'src/index.ts', 'y', opened.mtimeMs, opened.encodingId, { recreate: true })
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('y')
  })

  // O Node cria esses nomes de verdade no Windows, e o Explorer não apaga o que sobra: a pasta temporária sai no fim.
  it('não recria com nome reservado do Windows nem terminado em ponto ou espaço, inclusive na pasta que sumiu', () => {
    try {
      for (const rel of ['nul', 'con.txt', 'src/aux.ts', 'notas.', 'notas ', 'novo./a.txt', 'COM1/a.txt']) {
        expect(() => writeText(root, rel, 'x', 0, 'utf8', { recreate: true }), rel).toThrow(/^Não foi possível recriar .*(reservado|ponto ou espaço)/)
      }
      expect(readdirSync(root).sort()).toEqual(['.git', 'CLAUDE.md', 'b.txt', 'src'])
      expect(readdirSync(join(root, 'src'))).toEqual(['index.ts'])
      // Pasta que já existe com um nome desses (criada por outro programa) continua aceitando o arquivo recriado.
      mkdirSync(join(root, 'velho.'))
      writeText(root, 'velho./a.txt', 'ok', 0, 'utf8', { recreate: true })
      expect(readFileSync(join(root, 'velho.', 'a.txt'), 'utf8')).toBe('ok')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
