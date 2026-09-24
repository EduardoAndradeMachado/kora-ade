import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserCommandFor, createEntry, defaultBrowserTemplate, parseRegValue, renameEntry, validateEntryName } from '../src/main/file-actions'
import { MoveConflictError } from '../src/main/files'

describe('criar arquivo/pasta pelo explorador', () => {
  it('cria arquivo vazio e pasta dentro da pasta escolhida', () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-create-'))
    createEntry(root, '', 'src', 'dir')
    const rel = createEntry(root, 'src', 'índice.ts', 'file')
    expect(rel).toBe(join('src', 'índice.ts'))
    expect(statSync(join(root, 'src')).isDirectory()).toBe(true)
    expect(statSync(join(root, rel)).size).toBe(0)
  })

  it('não sobrescreve algo que já existe', () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-create-'))
    createEntry(root, '', 'a.txt', 'file')
    expect(() => createEntry(root, '', 'a.txt', 'file')).toThrow(/Já existe/)
    expect(() => createEntry(root, '', 'A.TXT', 'dir')).toThrow(/Já existe/)
  })

  it('recusa nomes que o Windows alteraria ou não aceita, e caminhos fora do projeto', () => {
    for (const bad of ['', '  ', '..', 'a/b', 'a\\b', 'x:y', 'nome.', 'nome. ', 'CON', 'nul.txt', 'com1', 'a*b']) {
      expect(() => validateEntryName(bad), bad).toThrow()
    }
    const root = mkdtempSync(join(tmpdir(), 'kora-create-'))
    const escape = `fora-${Date.now()}.txt`
    expect(() => createEntry(root, '..', escape, 'file')).toThrow(/fora do projeto/)
    expect(existsSync(join(root, '..', escape))).toBe(false)
  })

  it('aceita nomes comuns com ponto, acento e espaço no meio', () => {
    expect(validateEntryName('.env.local')).toBe('.env.local')
    expect(validateEntryName(' Relatório final.md ')).toBe('Relatório final.md')
  })
})

describe('abrir no navegador padrão', () => {
  const url = 'file:///C:/proj/relat%C3%B3rio%20final.html'

  it('monta o comando do Chrome, Edge e Firefox a partir do registro', () => {
    expect(browserCommandFor('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1', url)).toEqual({
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--single-argument', url]
    })
    expect(
      browserCommandFor(
        '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1',
        url
      ).args
    ).toEqual(['--single-argument', url])
    expect(browserCommandFor('"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"', url).args).toEqual([
      '-osint',
      '-url',
      url
    ])
  })

  it('sem %1 no comando, a URL vai no fim', () => {
    expect(browserCommandFor('C:\\browser.exe --new-tab', url)).toEqual({ exe: 'C:\\browser.exe', args: ['--new-tab', url] })
  })

  it('lê o valor do reg query (formato real do reg.exe em português)', () => {
    const out =
      '\r\nHKEY_CLASSES_ROOT\\ChromeHTML\\shell\\open\\command\r\n    (padrão)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1\r\n\r\n'
    expect(parseRegValue(out)).toBe('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1')
  })

  // Depende do navegador padrão configurado no Windows do usuário; o runner do CI não tem um.
  it.skipIf(process.env['CI'])('encontra o navegador padrão real desta máquina', async () => {
    const template = await defaultBrowserTemplate()
    const { exe } = browserCommandFor(template, url)
    expect(existsSync(exe)).toBe(true)
  })
})

describe('renomear pelo explorador', () => {
  const setup = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'kora-rename-'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'a.txt'), 'a')
    writeFileSync(join(root, 'docs', 'b.txt'), 'b')
    mkdirSync(join(root, '.git'))
    return root
  }

  it('renomeia arquivo e pasta no lugar, devolvendo o caminho novo', () => {
    const root = setup()
    expect(renameEntry(root, join('docs', 'a.txt'), 'novo.txt')).toBe(join('docs', 'novo.txt'))
    expect(readFileSync(join(root, 'docs', 'novo.txt'), 'utf8')).toBe('a')
    expect(existsSync(join(root, 'docs', 'a.txt'))).toBe(false)
    expect(renameEntry(root, 'docs', 'documentos')).toBe('documentos')
    expect(existsSync(join(root, 'documentos', 'b.txt'))).toBe(true)
  })

  it('não sobrescreve item existente, mas deixa trocar só as maiúsculas', () => {
    const root = setup()
    expect(() => renameEntry(root, join('docs', 'a.txt'), 'b.txt')).toThrow(MoveConflictError)
    expect(readFileSync(join(root, 'docs', 'b.txt'), 'utf8')).toBe('b')
    renameEntry(root, join('docs', 'a.txt'), 'A.txt')
    expect(readdirSync(join(root, 'docs'))).toContain('A.txt')
  })

  it('recusa nome inválido, raiz, .git e item sumido (com ENOENT)', () => {
    const root = setup()
    expect(() => renameEntry(root, join('docs', 'a.txt'), 'x/y.txt')).toThrow(/não pode conter/)
    expect(() => renameEntry(root, join('docs', 'a.txt'), '..')).toThrow(/inválido/)
    expect(() => renameEntry(root, '', 'outro')).toThrow(/raiz/)
    expect(() => renameEntry(root, '.git', 'git')).toThrow(/Não é possível renomear/)
    expect(() => renameEntry(root, 'docs', '.git')).toThrow(/Não é possível renomear/)
    expect(() => renameEntry(root, join('docs', 'sumiu.txt'), 'z.txt')).toThrow(/^ENOENT/)
    expect(() => renameEntry(root, join('..', 'fora'), 'z')).toThrow(/fora do projeto/)
  })
})
