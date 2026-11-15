import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readText, writeText } from '../src/main/files'

let root: string
let locks: ChildProcess[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kora-safe-write-'))
})

afterEach(async () => {
  for (const lock of locks) {
    lock.stdin?.end('\n')
    await new Promise((done) => (lock.exitCode === null ? lock.once('exit', done) : done(null)))
  }
  locks = []
})

const save = (rel: string, content: string): number => writeText(root, rel, content, readText(root, rel).mtimeMs)
const leftovers = (dir = root): string[] => readdirSync(dir).filter((name) => name.endsWith('.kora-tmp'))
const attributes = (file: string): string => execFileSync('attrib', [file], { encoding: 'utf8' }).slice(0, 20)

// Trava de verdade em outro processo, como um programa do Windows que abriu o arquivo.
async function lockFile(file: string, share: 'None' | 'ReadWrite'): Promise<void> {
  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$h = [IO.File]::Open('${file}', 'Open', 'ReadWrite', '${share}'); 'travado'; [Console]::In.ReadLine() | Out-Null; $h.Close()`
  ])
  locks.push(ps)
  await new Promise((done, fail) => {
    ps.stdout.once('data', done)
    ps.once('exit', (code) => fail(new Error(`PowerShell saiu antes de travar (${code})`)))
  })
}

describe('salvar arquivo do usuário sem arriscar o original', () => {
  it('grava o conteúdo inteiro, devolve o mtime do disco e não deixa temporário', () => {
    writeFileSync(join(root, 'a.txt'), 'antigo')
    const mtime = save('a.txt', 'novo conteúdo com acentuação')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('novo conteúdo com acentuação')
    expect(mtime).toBe(statSync(join(root, 'a.txt')).mtimeMs)
    expect(leftovers()).toEqual([])
  })

  it('texto menor que o anterior não deixa sobra do conteúdo antigo', () => {
    writeFileSync(join(root, 'a.txt'), 'x'.repeat(10_000))
    save('a.txt', 'curto')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('curto')
  })

  it('somente leitura é recusado com mensagem legível e o arquivo fica como estava', () => {
    const file = join(root, 'ro.txt')
    writeFileSync(file, 'protegido')
    chmodSync(file, 0o444)
    expect(() => save('ro.txt', 'por cima')).toThrow(/somente leitura: ro\.txt/)
    expect(readFileSync(file, 'utf8')).toBe('protegido')
    expect(leftovers()).toEqual([])
  })

  it('arquivo oculto salva e continua oculto', () => {
    const file = join(root, 'oculto.txt')
    writeFileSync(file, 'antes')
    execFileSync('attrib', ['+h', file])
    save('oculto.txt', 'depois')
    expect(readFileSync(file, 'utf8')).toBe('depois')
    expect(attributes(file)).toContain('H')
    expect(leftovers()).toEqual([])
  })

  it('hard link: o outro nome também vê o texto salvo (o link não é quebrado)', () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'antes, com um texto mais comprido que o novo')
    linkSync(file, join(root, 'outro-nome.txt'))
    save('a.txt', 'depois')
    expect(readFileSync(join(root, 'outro-nome.txt'), 'utf8')).toBe('depois')
    expect(statSync(file).nlink).toBe(2)
  })

  it('fluxo alternativo do NTFS (arquivo:fluxo) continua lá depois de salvar', () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'antes')
    writeFileSync(`${file}:meta`, 'dados do fluxo')
    save('a.txt', 'depois')
    expect(readFileSync(file, 'utf8')).toBe('depois')
    expect(readFileSync(`${file}:meta`, 'utf8')).toBe('dados do fluxo')
    expect(readdirSync(root)).toEqual(['a.txt'])
  })

  it('pasta por junção dentro do projeto: grava no alvo e a junção continua junção', () => {
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'a.txt'), 'antes')
    symlinkSync(join(root, 'real'), join(root, 'atalho'), 'junction')
    save(join('atalho', 'a.txt'), 'depois')
    expect(readFileSync(join(root, 'real', 'a.txt'), 'utf8')).toBe('depois')
    expect(readdirSync(join(root, 'atalho'))).toEqual(['a.txt'])
    expect(leftovers(join(root, 'real'))).toEqual([])
  })

  // Link simbólico de arquivo pede o Modo de Desenvolvedor ou administrador no Windows.
  const canSymlink = ((): boolean => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-symlink-probe-'))
    try {
      writeFileSync(join(dir, 'alvo'), '')
      symlinkSync(join(dir, 'alvo'), join(dir, 'link'), 'file')
      return true
    } catch {
      return false
    }
  })()
  it.skipIf(!canSymlink)('link simbólico de arquivo: grava no alvo e o link continua link', async () => {
    const { lstatSync } = await import('node:fs')
    writeFileSync(join(root, 'alvo.txt'), 'antes')
    symlinkSync(join(root, 'alvo.txt'), join(root, 'link.txt'), 'file')
    save('link.txt', 'depois')
    expect(lstatSync(join(root, 'link.txt')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(root, 'alvo.txt'), 'utf8')).toBe('depois')
  })

  it('aberto em programa que deixa escrever mas não renomear: salva no próprio arquivo', async () => {
    const file = join(root, 'aberto.txt')
    writeFileSync(file, 'antes')
    const mtime = readText(root, 'aberto.txt').mtimeMs
    await lockFile(file, 'ReadWrite')
    writeText(root, 'aberto.txt', 'depois', mtime)
    expect(readFileSync(file, 'utf8')).toBe('depois')
    expect(leftovers()).toEqual([])
  })

  it('travado por completo em outro programa: erro legível, original intacto e nenhum temporário', async () => {
    const file = join(root, 'travado.txt')
    writeFileSync(file, 'original')
    const mtime = readText(root, 'travado.txt').mtimeMs
    await lockFile(file, 'None')
    expect(() => writeText(root, 'travado.txt', 'novo', mtime)).toThrow(/aberto em outro programa.*travado\.txt/)
    expect(leftovers()).toEqual([])
    const lock = locks.pop()!
    lock.stdin!.end('\n')
    await new Promise((done) => lock.once('exit', done))
    expect(existsSync(file) && readFileSync(file, 'utf8')).toBe('original')
  })
})
