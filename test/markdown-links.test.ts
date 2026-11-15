import { describe, expect, it } from 'vitest'
import { parseKoraFileUrl } from '../src/shared/file-url'
import {
  ALLOWED_URI,
  headingSlug,
  isSameDocument,
  mobileRawUrl,
  resolveImage,
  resolveImageSrc,
  resolveMarkdownHref,
  resolveProjectPath
} from '../src/renderer/src/lib/markdown-links'

const DOC = 'docs\\guia\\leia.md'

describe('resolveProjectPath', () => {
  it('resolve relativo à pasta do .md, não à raiz', () => {
    expect(resolveProjectPath(DOC, 'img/logo.png')).toBe('docs\\guia\\img\\logo.png')
    expect(resolveProjectPath(DOC, './img/logo.png')).toBe('docs\\guia\\img\\logo.png')
    expect(resolveProjectPath('README.md', 'assets/logo.png')).toBe('assets\\logo.png')
  })

  it('sobe com ../ até a raiz do projeto', () => {
    expect(resolveProjectPath(DOC, '../outro.md')).toBe('docs\\outro.md')
    expect(resolveProjectPath(DOC, '../../README.md')).toBe('README.md')
    expect(resolveProjectPath(DOC, 'a/../../b.md')).toBe('docs\\b.md')
  })

  it('recusa sair do projeto', () => {
    expect(resolveProjectPath(DOC, '../../../segredo.txt')).toBeNull()
    expect(resolveProjectPath('README.md', '../x.md')).toBeNull()
    expect(resolveProjectPath(DOC, 'a/../../../../x')).toBeNull()
  })

  it('/ no começo é a raiz do projeto; caminho absoluto do Windows fica de fora', () => {
    expect(resolveProjectPath(DOC, '/src/app.ts')).toBe('src\\app.ts')
    expect(resolveProjectPath(DOC, '/../x')).toBeNull()
    expect(resolveProjectPath(DOC, 'C:\\Windows\\win.ini')).toBeNull()
    expect(resolveProjectPath(DOC, 'C:/Windows/win.ini')).toBeNull()
    expect(resolveProjectPath(DOC, '\\\\servidor\\pasta\\a.md')).toBeNull()
  })

  it('aceita separador do Windows no link', () => {
    expect(resolveProjectPath(DOC, '..\\outro.md')).toBe('docs\\outro.md')
  })
})

describe('resolveMarkdownHref', () => {
  it('âncora do próprio documento, decodificada', () => {
    expect(resolveMarkdownHref('#instalação', DOC)).toEqual({ kind: 'anchor', anchor: 'instalação' })
    expect(resolveMarkdownHref('#instala%C3%A7%C3%A3o', DOC)).toEqual({ kind: 'anchor', anchor: 'instalação' })
  })

  it('http(s) e mailto vão para o navegador', () => {
    expect(resolveMarkdownHref('https://example.com/a#b', DOC)).toEqual({ kind: 'external', url: 'https://example.com/a#b' })
    expect(resolveMarkdownHref('mailto:a@b.com', DOC)).toEqual({ kind: 'external', url: 'mailto:a@b.com' })
  })

  it('outro scheme não abre nada', () => {
    expect(resolveMarkdownHref('file:///C:/x.md', DOC).kind).toBe('blocked')
    expect(resolveMarkdownHref('vscode://file/x', DOC).kind).toBe('blocked')
  })

  it('arquivo relativo, com espaço codificado', () => {
    expect(resolveMarkdownHref('meu%20guia.md', DOC)).toEqual({ kind: 'file', rel: 'docs\\guia\\meu guia.md', line: null, anchor: null })
    expect(resolveMarkdownHref('a.md?raw=1', DOC)).toEqual({ kind: 'file', rel: 'docs\\guia\\a.md', line: null, anchor: null })
  })

  it('arquivo com #seção leva a seção (decodificada) junto', () => {
    expect(resolveMarkdownHref('../outro.md#secao', DOC)).toEqual({ kind: 'file', rel: 'docs\\outro.md', line: null, anchor: 'secao' })
    expect(resolveMarkdownHref('outro.md#instala%C3%A7%C3%A3o', DOC)).toEqual({ kind: 'file', rel: 'docs\\guia\\outro.md', line: null, anchor: 'instalação' })
    // Seção cujo slug começa com L e número não é linha.
    expect(resolveMarkdownHref('outro.md#L10-notas', DOC)).toEqual({ kind: 'file', rel: 'docs\\guia\\outro.md', line: null, anchor: 'L10-notas' })
  })

  it('linha por #L10, #L10-L20 ou :10, sem seção', () => {
    expect(resolveMarkdownHref('/src/app.ts#L10', DOC)).toEqual({ kind: 'file', rel: 'src\\app.ts', line: 10, anchor: null })
    expect(resolveMarkdownHref('/src/app.ts#L10-L20', DOC)).toEqual({ kind: 'file', rel: 'src\\app.ts', line: 10, anchor: null })
    expect(resolveMarkdownHref('../../src/app.ts:42', DOC)).toEqual({ kind: 'file', rel: 'src\\app.ts', line: 42, anchor: null })
    expect(resolveMarkdownHref('../../src/app.ts:42:7', DOC)).toEqual({ kind: 'file', rel: 'src\\app.ts', line: 42, anchor: null })
  })

  it('o próprio documento com #seção é âncora dele, não outro arquivo', () => {
    const link = resolveMarkdownHref('leia.md#uso', DOC)
    expect(link.kind === 'file' && isSameDocument(link.rel, DOC)).toBe(true)
    expect(isSameDocument('DOCS/guia/LEIA.md', DOC)).toBe(true)
    expect(isSameDocument('docs\\guia\\outro.md', DOC)).toBe(false)
  })

  it('fora do projeto vira aviso, não abre', () => {
    expect(resolveMarkdownHref('../../../x.md', DOC).kind).toBe('blocked')
    expect(resolveMarkdownHref('C:/Windows/win.ini', DOC).kind).toBe('blocked')
  })

  it('href vazio não faz nada', () => {
    expect(resolveMarkdownHref('  ', DOC)).toEqual({ kind: 'none' })
  })
})

describe('resolveImageSrc', () => {
  it('relativo ao .md vira kora-file do arquivo certo', () => {
    const url = resolveImageSrc('img/logo 1.png', DOC, 'Proj-1')
    expect(url).not.toBeNull()
    expect(parseKoraFileUrl(url as string)).toEqual({ projectId: 'Proj-1', rel: 'docs/guia/img/logo 1.png' })
    expect(parseKoraFileUrl(resolveImageSrc('../a%20b.png', DOC, 'Proj-1') as string).rel).toBe('docs/a b.png')
  })

  it('remota e data: ficam como estão', () => {
    expect(resolveImageSrc('https://x.com/a.png', DOC, 'P')).toBe('https://x.com/a.png')
    expect(resolveImageSrc('data:image/png;base64,AAAA', DOC, 'P')).toBe('data:image/png;base64,AAAA')
  })

  it('fora do projeto, absoluta ou kora-file à mão vira imagem quebrada', () => {
    expect(resolveImageSrc('../../../x.png', DOC, 'P')).toBeNull()
    expect(resolveImageSrc('C:/x.png', DOC, 'P')).toBeNull()
    expect(resolveImageSrc('kora-file://project/Outro/x.png', DOC, 'P')).toBeNull()
    expect(resolveImageSrc('file:///C:/x.png', DOC, 'P')).toBeNull()
    expect(resolveImageSrc('', DOC, 'P')).toBeNull()
  })
})

describe('mobileRawUrl', () => {
  const RAW = '/raw/tok_en-1/docs/guia/leia.md'

  it('na pasta do .md (ou abaixo), usa a chave do link de leitura dele', () => {
    expect(mobileRawUrl(RAW, DOC, 'docs\\guia\\img\\logo 1.png')).toBe('/raw/tok_en-1/docs/guia/img/logo%201.png')
    expect(mobileRawUrl(RAW, DOC, 'docs\\guia\\a#b.png')).toBe('/raw/tok_en-1/docs/guia/a%23b.png')
    expect(mobileRawUrl('/raw/k/README.md', 'README.md', 'assets\\x.png')).toBe('/raw/k/assets/x.png')
  })

  it('fora da pasta ou oculto a partir dela: o link do .md não entrega, pede outro', () => {
    expect(mobileRawUrl(RAW, DOC, 'docs\\outro.png')).toBeNull()
    expect(mobileRawUrl(RAW, DOC, 'assets\\x.png')).toBeNull()
    expect(mobileRawUrl(RAW, DOC, 'docs\\guiaX\\x.png')).toBeNull()
    expect(mobileRawUrl(RAW, DOC, 'docs\\guia\\.cache\\x.png')).toBeNull()
    expect(mobileRawUrl('/raw/k/README.md', 'README.md', '.env')).toBeNull()
  })

  it('a imagem resolvida pelo resolveImage chega no link certo', () => {
    const image = resolveImage('./img/a.png?x=1', DOC)
    expect(image).toEqual({ kind: 'file', rel: 'docs\\guia\\img\\a.png' })
    expect(resolveImage('/assets/a.png', DOC)).toEqual({ kind: 'file', rel: 'assets\\a.png' })
    expect(resolveImage('data:image/png;base64,AA', DOC)).toEqual({ kind: 'inline', url: 'data:image/png;base64,AA' })
    expect(resolveImage('../../../x.png', DOC)).toBeNull()
  })
})

describe('headingSlug', () => {
  const slugs = (...titles: string[]): string[] => {
    const seen = new Map<string, number>()
    return titles.map((t) => headingSlug(t, seen))
  }

  it('como o GitHub: minúsculas, sem pontuação, espaço vira hífen, acento fica', () => {
    expect(slugs('Hello World!', 'Seção 2.1: Instalação', 'API (v2) — uso', 'snake_case e-hífen')).toEqual([
      'hello-world',
      'seção-21-instalação',
      'api-v2--uso',
      'snake_case-e-hífen'
    ])
  })

  it('repetidos ganham -1, -2, sem colidir com um título que já termina em -1', () => {
    expect(slugs('Uso', 'Uso', 'Uso')).toEqual(['uso', 'uso-1', 'uso-2'])
    expect(slugs('Uso', 'Uso 1', 'Uso')).toEqual(['uso', 'uso-1', 'uso-2'])
  })
})

describe('links que passam pela sanitização', () => {
  it('aceita arquivo com :linha e os links de antes; recusa scheme perigoso', () => {
    for (const ok of ['app.ts:42', 'src/app.ts:42:5', 'docs/guia.md', '../README.md#titulo', '#secao', 'https://example.com', 'mailto:a@b.c']) {
      expect(ALLOWED_URI.test(ok), ok).toBe(true)
    }
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'javascript.x:alert(1)']) {
      expect(ALLOWED_URI.test(bad), bad).toBe(false)
    }
  })
})
