import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { koraFileUrl, parseKoraFileUrl, windowsFileUrl } from '../src/shared/file-url'
import { KoraFileError, resolveKoraFileRequest } from '../src/main/file-request'

// O Chromium canonicaliza a URL de um scheme "standard" como faria com https (host em minúsculas,
// `\` vira `/`, segmentos `.`/`..` resolvidos) antes de ela chegar ao handler do main.
const asChromiumSees = (url: string): string =>
  new URL(url.replace(/^kora-file:/, 'https:')).href.replace(/^https:/, 'kora-file:')

const WEIRD_NAMES = [
  ['relatório final.pdf', 'relatório final.pdf'],
  ['a#1.png', 'a#1.png'],
  ['100%.png', '100%.png'],
  ['por quê?.svg', 'por quê?.svg'],
  ['docs\\sub pasta\\ação #2.pdf', 'docs/sub pasta/ação #2.pdf'],
  ['docs/img/%20literal.png', 'docs/img/%20literal.png']
] as const

let parent: string
let root: string
const getRoot = (id: string): string => {
  if (id === 'Proj-1') return root
  throw new Error(`Projeto desconhecido: ${id}`)
}

function expectStatus(fn: () => unknown, status: number): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(KoraFileError)
  expect((caught as KoraFileError).status).toBe(status)
}

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'kora-file-url-'))
  root = join(parent, 'projeto')
  mkdirSync(join(root, 'docs', 'sub pasta'), { recursive: true })
  mkdirSync(join(root, 'docs', 'img'), { recursive: true })
  writeFileSync(join(parent, 'segredo.env'), 'TOKEN=123', 'utf8')
})

describe('URL kora-file', () => {
  it.each(WEIRD_NAMES)('ida e volta preserva o caminho %j', (rel, expected) => {
    const url = koraFileUrl('Proj-1', rel)
    expect(parseKoraFileUrl(asChromiumSees(url))).toEqual({ projectId: 'Proj-1', rel: expected })
  })

  it('subpastas do Windows viram segmentos da URL, com cada nome escapado', () => {
    expect(koraFileUrl('Proj-1', 'docs\\sub pasta\\a#1.pdf')).toBe(
      'kora-file://project/Proj-1/docs/sub%20pasta/a%231.pdf'
    )
  })

  it('ignora a query e o fragmento que o visualizador acrescenta (recarregar, #page=)', () => {
    const url = `${koraFileUrl('Proj-1', 'docs\\manual.pdf')}?v=3#page=2`
    expect(parseKoraFileUrl(asChromiumSees(url))).toEqual({ projectId: 'Proj-1', rel: 'docs/manual.pdf' })
  })

  // `?` não é permitido em nome de arquivo no Windows.
  it.each(WEIRD_NAMES.filter(([rel]) => !rel.includes('?')))('o handler encontra no disco o arquivo %j', (rel) => {
    writeFileSync(join(root, ...rel.split(/[\\/]/)), `conteúdo de ${rel}`, 'utf8')
    const file = resolveKoraFileRequest(asChromiumSees(koraFileUrl('Proj-1', rel)), getRoot)
    expect(readFileSync(file, 'utf8')).toBe(`conteúdo de ${rel}`)
  })
})

describe('handler kora-file recusa sair do projeto', () => {
  // `..` literal é resolvido pela canonicalização antes do handler; o que sobrevive até
  // o main são separadores escapados dentro de um segmento.
  it.each([
    'kora-file://project/Proj-1/..%2Fsegredo.env',
    'kora-file://project/Proj-1/docs/..%5C..%5Csegredo.env',
    'kora-file://project/Proj-1/%2E%2E%2Fsegredo.env'
  ])('%s', (url) => {
    expect(() => readFileSync(join(root, '..', 'segredo.env'))).not.toThrow()
    expectStatus(() => resolveKoraFileRequest(asChromiumSees(url), getRoot), 403)
  })

  it('caminho absoluto montado pelo renderer', () => {
    const url = koraFileUrl('Proj-1', join(parent, 'segredo.env'))
    expectStatus(() => resolveKoraFileRequest(asChromiumSees(url), getRoot), 403)
  })

  it('caminho absoluto escapado num segmento só', () => {
    const url = `kora-file://project/Proj-1/${encodeURIComponent(join(parent, 'segredo.env'))}`
    expectStatus(() => resolveKoraFileRequest(asChromiumSees(url), getRoot), 403)
  })

  it('projeto desconhecido responde 404', () => {
    expectStatus(() => resolveKoraFileRequest(koraFileUrl('outro', 'a.png'), getRoot), 404)
  })

  it.each([
    'kora-file://project/Proj-1',
    'kora-file://project/Proj-1/',
    'kora-file://outro-host/Proj-1/a.png',
    'https://project/Proj-1/a.png',
    'kora-file://project/Proj-1/%E0%A4%A.png'
  ])('URL malformada responde 400: %s', (url) => {
    expectStatus(() => resolveKoraFileRequest(url, getRoot), 400)
  })
})

describe('caminho do Windows como link file:// para o navegador', () => {
  it('bate com o pathToFileURL do Node em espaço, #, %, acento e pasta de rede', () => {
    for (const path of [
      'C:\\Users\\voce\\projeto\\index.html',
      'C:\\Users\\voce\\meu projeto\\relatório #2 (100%).pdf',
      'D:\\dados\\config.json',
      '\\\\servidor\\compartilhado\\notas.md'
    ]) {
      expect(windowsFileUrl(path), path).toBe(pathToFileURL(path).href)
    }
  })
})
