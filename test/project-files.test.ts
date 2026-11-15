import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { latestSearch, listProjectFiles, MAX_SEARCH_RESULTS, normalizeSearchOptions, searchProject } from '../src/main/project-files'
import type { ProjectSearchOptions, ProjectSearchResult } from '../src/shared/ipc'

const savedEnv = { ...process.env }
const tempDirs: string[] = []
let root: string

// A config global do dono (core.excludesFile, autocrlf) não pode mudar o que é listado.
beforeAll(() => {
  const isolation = mkdtempSync(join(tmpdir(), 'kora-pf-env-'))
  tempDirs.push(isolation)
  const emptyConfig = join(isolation, 'gitconfig')
  writeFileSync(emptyConfig, '', 'utf8')
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CEILING_DIRECTORIES = tmpdir()
})

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES']) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-pf-')))
  tempDirs.push(root)
})

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(): void {
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Teste Kora')
  git('config', 'user.email', 'teste@kora.local')
  git('config', 'commit.gpgsign', 'false')
}

function write(rel: string, content: string | Buffer): void {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

const TEXT: ProjectSearchOptions = { caseSensitive: false, wholeWord: false, regex: false }

async function search(query: string, opts: Partial<ProjectSearchOptions> = {}): Promise<ProjectSearchResult> {
  const result = await searchProject(root, query, { ...TEXT, ...opts })
  if (!result) throw new Error('busca cancelada')
  return result
}

const hits = (result: ProjectSearchResult): string[] =>
  result.files.flatMap((f) => f.matches.map((m) => `${f.path}:${m.line}:${m.column}`))

describe('listProjectFiles', () => {
  it('no git lista rastreados e não rastreados, sem ignorados, apagados nem node_modules', async () => {
    initRepo()
    write('.gitignore', 'build/\n*.log\n')
    write('rastreado.ts', 'x')
    write('some.ts', 'x')
    write(join('pasta', 'ação com espaço.md'), 'x')
    write(join('build', 'saida.js'), 'x')
    write('erro.log', 'x')
    git('add', '-A')
    git('commit', '-q', '-m', 'inicial')
    unlinkSync(join(root, 'some.ts'))
    write('novo não rastreado.txt', 'x')
    write(join('node_modules', 'pkg', 'index.js'), 'x')

    expect(await listProjectFiles(root)).toEqual(['.gitignore', 'novo não rastreado.txt', 'pasta\\ação com espaço.md', 'rastreado.ts'])
  })

  it('com o projeto numa subpasta do repositório, os caminhos saem relativos ao projeto', async () => {
    initRepo()
    write(join('app', 'src', 'main.ts'), 'x')
    write('fora.ts', 'x')
    git('add', '-A')
    git('commit', '-q', '-m', 'inicial')

    expect(await listProjectFiles(join(root, 'app'))).toEqual(['src\\main.ts'])
  })

  it('submódulo não entra na lista como se fosse arquivo', async () => {
    initRepo()
    write('a.ts', 'x')
    write(join('sm', 'dentro.ts'), 'x')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: join(root, 'sm'), windowsHide: true })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: join(root, 'sm'), windowsHide: true })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x'], { cwd: join(root, 'sm'), windowsHide: true })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, 'sm'), windowsHide: true, encoding: 'utf8' }).trim()
    git('add', 'a.ts')
    git('update-index', '--add', '--cacheinfo', `160000,${sha},sm`)
    git('commit', '-q', '-m', 'inicial')

    expect(await listProjectFiles(root)).toEqual(['a.ts'])
  })

  it('fora do git caminha no disco pulando .git e node_modules', async () => {
    write('a.txt', 'x')
    write(join('docs', 'é.md'), 'x')
    write(join('.git', 'HEAD'), 'x')
    write(join('node_modules', 'pkg', 'index.js'), 'x')
    write(join('dist', 'saida.js'), 'x')

    expect(await listProjectFiles(root)).toEqual(['a.txt', 'dist\\saida.js', 'docs\\é.md'])
  })
})

describe('searchProject', () => {
  it('acha texto literal com linha e coluna, sem diferenciar maiúsculas por padrão', async () => {
    write('a.ts', 'primeira\r\n  const Ação = 1\rterceira ação.x\n')
    write('b.ts', 'nada aqui\n')

    expect(hits(await search('ação'))).toEqual(['a.ts:2:9', 'a.ts:3:10'])
    expect(hits(await search('ação', { caseSensitive: true }))).toEqual(['a.ts:3:10'])
    // Caractere especial de regex no modo texto é literal.
    write('c.ts', 'a.x e aXx\n')
    expect(hits(await search('a.x'))).toEqual(['c.ts:1:1'])
  })

  it('palavra inteira respeita letras acentuadas', async () => {
    write('a.md', 'verão\nver.\nrever\nãver\n')

    expect(hits(await search('ver', { wholeWord: true }))).toEqual(['a.md:2:1'])
  })

  it('regex usa a expressão e recusa a inválida com mensagem', async () => {
    write('a.ts', 'foo1 fooo22 fo\n')

    expect(hits(await search('fo+\\d', { regex: true }))).toEqual(['a.ts:1:1', 'a.ts:1:6'])
    await expect(search('(abc', { regex: true })).rejects.toThrow(/Expressão regular inválida/)
  })

  it('pasta rastreada trocada por junção para fora do projeto não tem o conteúdo lido', async () => {
    initRepo()
    write(join('docs', 'a.txt'), 'segredo de dentro\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'inicial')
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-pf-fora-')))
    tempDirs.push(outside)
    writeFileSync(join(outside, 'a.txt'), 'segredo de fora\n')
    rmSync(join(root, 'docs'), { recursive: true, force: true })
    symlinkSync(outside, join(root, 'docs'), 'junction')

    expect(hits(await search('segredo'))).toEqual([])
  })

  it('texto literal com hífen e barra não vira regex inválida', async () => {
    write('a.css', '.btn-primary { }\n/* 2026-11-15 a/b */\n')

    expect(hits(await search('btn-primary'))).toEqual(['a.css:1:2'])
    expect(hits(await search('2026-11-15 a/b', { wholeWord: true }))).toEqual(['a.css:2:4'])
  })

  it('regex que casa vazio passa por emoji sem travar', async () => {
    write('a.txt', 'a\u{1F600}b 12\n')

    const started = Date.now()
    expect(hits(await search('\\d*', { regex: true }))).toEqual(['a.txt:1:6'])
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('regex catastrófica é interrompida em vez de travar o processo', async () => {
    write('a.txt', 'a'.repeat(29) + 'b\n')

    const started = Date.now()
    await expect(search('(a+)+$', { regex: true })).rejects.toThrow(/demorou demais em a\.txt/)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('pula binário, arquivo grande demais e ignorado pelo git; lê UTF-16 e Windows-1252', async () => {
    initRepo()
    write('.gitignore', 'ignorado.txt\n')
    write('ignorado.txt', 'agulha\n')
    write('bin.dat', Buffer.concat([Buffer.from('agulha'), Buffer.from([0, 1, 2])]))
    write('grande.txt', 'agulha\n' + 'x'.repeat(5 * 1024 * 1024))
    write('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('linha\nagulha ação\n', 'utf16le')]))
    write('cp1252.txt', Buffer.from([0x61, 0x67, 0x75, 0x6c, 0x68, 0x61, 0x20, 0x61, 0xe7, 0xe3, 0x6f])) // "agulha ação"

    expect(hits(await search('agulha'))).toEqual(['cp1252.txt:1:1', 'utf16.txt:2:1'])
    expect(hits(await search('ação'))).toEqual(['cp1252.txt:1:8', 'utf16.txt:2:8'])
  })

  it('o trecho corta linha longa em volta da ocorrência e marca onde ela está', async () => {
    write('min.js', '    ' + 'x'.repeat(500) + 'AGULHA' + 'y'.repeat(500))
    write('curta.ts', '\t\tconst agulha = 1')

    const result = await search('agulha')
    const long = result.files.find((f) => f.path === 'min.js')!.matches[0]!
    expect(long.preview.length).toBeLessThan(200)
    expect(long.preview.slice(long.start, long.end)).toBe('AGULHA')
    expect(long.preview.startsWith('…')).toBe(true)
    expect(long.preview.endsWith('…')).toBe(true)
    const short = result.files.find((f) => f.path === 'curta.ts')?.matches[0]
    expect(short).toMatchObject({ line: 1, column: 9, preview: 'const agulha = 1', start: 6, end: 12 })
  })

  it('o tamanho da ocorrência é o do trecho casado, em unidades UTF-16, mesmo quando o trecho mostrado a corta', async () => {
    write('a.txt', 'x \u{1F600}\u{1F600} fim\n')
    write('b.txt', 'id=' + '9'.repeat(400) + '\n')

    const emoji = await search('\u{1F600}+', { regex: true })
    expect(emoji.files[0]?.matches[0]).toMatchObject({ column: 3, length: 4 })
    const digits = await search('\\d+', { regex: true })
    const long = digits.files.find((f) => f.path === 'b.txt')!.matches[0]!
    expect(long).toMatchObject({ column: 4, length: 400 })
    expect(long.end - long.start).toBeLessThan(400)
  })

  it('corta no teto, avisa que truncou e mantém a ordem dos arquivos', async () => {
    const lines = (n: number): string => 'agulha\n'.repeat(n)
    // O primeiro arquivo é o mais lento de ler: termina depois dos outros e ainda assim vem antes no resultado.
    write('a.txt', lines(1_200) + 'x'.repeat(4 * 1024 * 1024))
    write('b.txt', lines(1_200))
    write('c.txt', lines(5))

    const over = await search('agulha')
    expect(over.truncated).toBe(true)
    expect(over.total).toBe(MAX_SEARCH_RESULTS)
    expect(over.files.map((f) => [f.path, f.matches.length])).toEqual([
      ['a.txt', 1_200],
      ['b.txt', MAX_SEARCH_RESULTS - 1_200]
    ])

    rmSync(join(root, 'b.txt'))
    rmSync(join(root, 'c.txt'))
    write('a.txt', lines(MAX_SEARCH_RESULTS))
    const exact = await search('agulha')
    expect(exact.truncated).toBe(false)
    expect(exact.total).toBe(MAX_SEARCH_RESULTS)
  })

  it('uma busca nova cancela a anterior', async () => {
    write('a.txt', 'agulha\n')
    const run = latestSearch()

    const first = run(root, 'agulha', TEXT)
    const second = run(root, 'agulha', TEXT)

    expect(await first).toBeNull()
    expect((await second)?.total).toBe(1)
  })

  it('texto vazio devolve vazio sem ler nada', async () => {
    write('a.txt', 'x\n')
    expect(await search('')).toEqual({ files: [], total: 0, truncated: false, capped: false })
  })
})

describe('searchProject com arquivos a incluir', () => {
  const found = async (include: string): Promise<string[]> => (await search('agulha', { include })).files.map((f) => f.path)

  it('pasta compara por segmento, sem diferenciar maiúsculas; ".\\" ancora na raiz e sem ele vale em qualquer nível', async () => {
    for (const rel of [join('Src', 'a.ts'), join('Src', 'sub', 'b.ts'), join('srcx', 'c.ts'), join('lib', 'src', 'd.ts'), 'e.ts']) {
      write(rel, 'agulha\n')
    }

    expect(await found('.\\src')).toEqual(['Src\\a.ts', 'Src\\sub\\b.ts'])
    expect(await found('./SRC/sub/')).toEqual(['Src\\sub\\b.ts'])
    expect(await found('src')).toEqual(['Src\\a.ts', 'Src\\sub\\b.ts', 'lib\\src\\d.ts'])
    expect(await found('.\\')).toHaveLength(5)
    expect(await found('.\\srcx, .\\')).toHaveLength(5)
    expect(await found(' , ')).toHaveLength(5)
  })

  it('aceita glob e lista separada por vírgula', async () => {
    for (const rel of ['a.md', join('docs', 'b.md'), join('docs', 'c.ts'), join('src', 'x.tsx'), join('src', 'deep', 'y.tsx'), join('src', 'z.ts'), join('lib', 'src', 'w.tsx')]) {
      write(rel, 'agulha\n')
    }

    expect(await found('*.md')).toEqual(['a.md', 'docs\\b.md'])
    expect(await found('src/**/*.tsx')).toEqual(['lib\\src\\w.tsx', 'src\\deep\\y.tsx', 'src\\x.tsx'])
    expect(await found('./src/*.tsx')).toEqual(['src\\x.tsx'])
    expect(await found('.\\docs, *.TSX')).toEqual(['docs\\b.md', 'docs\\c.ts', 'lib\\src\\w.tsx', 'src\\deep\\y.tsx', 'src\\x.tsx'])
  })

  it('o filtro chega pelo IPC e o que não é texto é descartado', async () => {
    write(join('src', 'a.ts'), 'agulha\n')
    write('b.ts', 'agulha\n')

    const viaIpc = await searchProject(root, 'agulha', normalizeSearchOptions({ include: '.\\src' }))
    expect(viaIpc?.files.map((f) => f.path)).toEqual(['src\\a.ts'])
    expect(normalizeSearchOptions({ include: 42 })).toEqual(TEXT)
  })
})

describe('searchProject com arquivos a excluir', () => {
  const found = async (opts: Partial<ProjectSearchOptions>): Promise<string[]> => (await search('agulha', opts)).files.map((f) => f.path)

  it('mesma sintaxe do incluir: pasta por segmento em qualquer nível, ".\\" na raiz, glob e lista por vírgula', async () => {
    for (const rel of [join('Src', 'a.ts'), join('srcx', 'b.ts'), join('lib', 'src', 'c.ts'), join('docs', 'd.md'), 'e.ts']) {
      write(rel, 'agulha\n')
    }

    expect(await found({ exclude: 'src' })).toEqual(['docs\\d.md', 'e.ts', 'srcx\\b.ts'])
    expect(await found({ exclude: '.\\SRC' })).toEqual(['docs\\d.md', 'e.ts', 'lib\\src\\c.ts', 'srcx\\b.ts'])
    expect(await found({ exclude: '*.ts' })).toEqual(['docs\\d.md'])
    expect(await found({ exclude: 'docs, lib/**/*.ts, srcx/' })).toEqual(['Src\\a.ts', 'e.ts'])
  })

  it('vale junto com o incluir; excluir a raiz ou só vírgulas não tira nada', async () => {
    for (const rel of [join('src', 'a.ts'), join('src', 'gerado', 'b.ts'), join('src', 'c.md'), 'd.ts']) write(rel, 'agulha\n')

    expect(await found({ include: '.\\src', exclude: 'gerado, *.md' })).toEqual(['src\\a.ts'])
    expect(await found({ exclude: '.\\' })).toHaveLength(4)
    expect(await found({ exclude: ' , ' })).toHaveLength(4)
  })

  it('o filtro chega pelo IPC; o que não é texto é descartado', async () => {
    write(join('src', 'a.ts'), 'agulha\n')
    write('b.ts', 'agulha\n')

    const viaIpc = await searchProject(root, 'agulha', normalizeSearchOptions({ exclude: 'src' }))
    expect(viaIpc?.files.map((f) => f.path)).toEqual(['b.ts'])
    expect(normalizeSearchOptions({ exclude: ['src'] })).toEqual(TEXT)
  })

  it('o excluir vem antes do teto: arquivos tirados não ocupam vaga', async () => {
    initRepo()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) write(join('gerado', name), 'agulha\n')
    write('z.txt', 'agulha\n')

    const result = await searchProject(root, 'agulha', { ...TEXT, exclude: 'gerado' }, undefined, 2)
    expect(result?.capped).toBe(false)
    expect(result?.files.map((f) => f.path)).toEqual(['z.txt'])
  })
})

describe('teto de arquivos do projeto', () => {
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']

  it('fora do git, passar do teto lê só os primeiros e avisa', async () => {
    for (const name of names) write(name, 'agulha\n')

    const result = await searchProject(root, 'agulha', TEXT, undefined, 3)
    expect(result?.capped).toBe(true)
    expect(result?.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(await listProjectFiles(root, 3)).toEqual(['a.txt', 'b.txt', 'c.txt'])

    // A caminhada parou antes de chegar à pasta: achar zero nela não pode parecer uma busca completa.
    write(join('z', 'um.txt'), 'agulha\n')
    const filtered = await searchProject(root, 'agulha', { ...TEXT, include: '.\\z' }, undefined, 3)
    expect(filtered?.capped).toBe(true)
  })

  it('no git, a lista exata no teto não avisa e uma a mais avisa', async () => {
    initRepo()
    for (const name of names) write(name, 'agulha\n')

    expect((await searchProject(root, 'agulha', TEXT, undefined, 5))?.capped).toBe(false)
    const over = await searchProject(root, 'agulha', TEXT, undefined, 4)
    expect(over?.capped).toBe(true)
    expect(over?.total).toBe(4)
  })

  it('o filtro de pasta vem antes do teto', async () => {
    initRepo()
    for (const name of names) write(name, 'agulha\n')
    write(join('z', 'um.txt'), 'agulha\n')
    write(join('z', 'dois.txt'), 'agulha\n')

    const result = await searchProject(root, 'agulha', { ...TEXT, include: '.\\z' }, undefined, 3)
    expect(result?.capped).toBe(false)
    expect(result?.files.map((f) => f.path)).toEqual(['z\\dois.txt', 'z\\um.txt'])
  })
})
