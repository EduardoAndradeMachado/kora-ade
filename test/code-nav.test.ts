import { describe, expect, it } from 'vitest'
import {
  MAX_NAV_FILES,
  isTsconfig,
  mergePaths,
  navCandidates,
  navCompilerOptions,
  parseJsonc,
  pathsFromTsconfig,
  projectUriPath,
  relFromUriPath
} from '../src/renderer/src/lib/code-nav-core'

// O worker de verdade do Monaco (o mesmo TypeScript que roda no editor) e a classe de URI que o editor usa. O
// especificador fica numa variável porque o pacote não publica tipos para esses módulos internos.
type UriClass = { file(path: string): { toString(): string }; parse(value: string): { path: string } }
type Entry = { fileName: string; textSpan: { start: number } }
type Worker = {
  getDefinitionAtPosition(file: string, offset: number): Promise<Entry[] | undefined>
  getReferencesAtPosition(file: string, offset: number): Promise<Entry[] | undefined>
}
const MONACO = 'monaco-editor/'
const { URI } = (await import(/* @vite-ignore */ `${MONACO}base/common/uri.js`)) as { URI: UriClass }
const { TypeScriptWorker } = (await import(/* @vite-ignore */ `${MONACO}languages/features/typescript/tsWorker.js`)) as {
  TypeScriptWorker: new (ctx: unknown, data: unknown) => Worker
}

const PROJECT = '3f2a1b4c-0000-4000-8000-000000000001'
const uriOf = (rel: string): string => URI.file(projectUriPath(PROJECT, rel)).toString()

const TSCONFIG = `{
  // apelidos do Vite
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/renderer/src/*"],
      "@shared/*": ["./src/shared/*",],
    },
  },
  /* fim */
}`

function workerFor(files: Record<string, string>, tsconfigs: Record<string, string>): Worker {
  const paths = mergePaths(Object.entries(tsconfigs).map(([rel, text]) => pathsFromTsconfig(rel, text, uriOf)))
  const extraLibs = Object.fromEntries(Object.entries(files).map(([rel, content]) => [uriOf(rel), { content, version: 1 }]))
  return new TypeScriptWorker({ getMirrorModels: () => [] }, { compilerOptions: navCompilerOptions(paths), extraLibs })
}

const relOf = (entry: Entry): string | null => relFromUriPath(PROJECT, URI.parse(entry.fileName).path)

describe('navegação entre arquivos do projeto no worker do TypeScript', () => {
  const app = [
    "import { soma } from './util.js'",
    "import { Botao } from '@/components/Botao'",
    "import { TIPO } from '@shared/tipos'",
    "import padrao from './pasta'",
    'export const total = soma(1, 2) + TIPO + padrao',
    'export const ui = Botao'
  ].join('\n')
  const files = {
    'src\\renderer\\src\\App.tsx': app,
    'src\\renderer\\src\\util.ts': 'export function soma(a: number, b: number) {\n  return a + b\n}\n',
    'src\\renderer\\src\\components\\Botao.tsx': 'export const Botao = () => <button />\n',
    'src\\shared\\tipos.ts': 'export const TIPO = 1\n',
    'src\\renderer\\src\\pasta\\index.js': 'export default 3\n'
  }

  const definitionOf = async (worker: Worker, symbol: string): Promise<(string | null)[]> => {
    const offset = app.lastIndexOf(symbol)
    const defs = await worker.getDefinitionAtPosition(uriOf('src\\renderer\\src\\App.tsx'), offset)
    return (defs ?? []).map(relOf)
  }

  it('F12 acha a definição em outro arquivo: import relativo com .js, apelido do tsconfig, pasta com index.js', async () => {
    const worker = workerFor(files, { 'tsconfig.web.json': TSCONFIG })
    expect(await definitionOf(worker, 'soma')).toEqual(['src\\renderer\\src\\util.ts'])
    expect(await definitionOf(worker, 'Botao')).toEqual(['src\\renderer\\src\\components\\Botao.tsx'])
    expect(await definitionOf(worker, 'TIPO')).toEqual(['src\\shared\\tipos.ts'])
    expect(await definitionOf(worker, 'padrao')).toEqual(['src\\renderer\\src\\pasta\\index.js'])
  })

  it('Shift+F12 lista as referências nos outros arquivos', async () => {
    const worker = workerFor(files, { 'tsconfig.web.json': TSCONFIG })
    const util = files['src\\renderer\\src\\util.ts']
    const refs = await worker.getReferencesAtPosition(uriOf('src\\renderer\\src\\util.ts'), util.indexOf('soma'))
    expect(new Set((refs ?? []).map(relOf))).toEqual(new Set(['src\\renderer\\src\\util.ts', 'src\\renderer\\src\\App.tsx']))
  })

  it('paths de um tsconfig em subpasta e com baseUrl resolvem a partir da pasta dele', async () => {
    const pkg = {
      'pacotes\\web\\src\\main.ts': "import { x } from 'lib/x'\nexport const y = x\n",
      'pacotes\\web\\fonte\\lib\\x.ts': 'export const x = 1\n'
    }
    const worker = workerFor(pkg, {
      'pacotes\\web\\tsconfig.json': '{ "compilerOptions": { "baseUrl": "./fonte", "paths": { "lib/*": ["lib/*"] } } }'
    })
    const defs = await worker.getDefinitionAtPosition(uriOf('pacotes\\web\\src\\main.ts'), pkg['pacotes\\web\\src\\main.ts'].lastIndexOf('x'))
    expect((defs ?? []).map(relOf)).toEqual(['pacotes\\web\\fonte\\lib\\x.ts'])
  })

  it('caminho com espaço e acento no nome da pasta continua sendo achado', async () => {
    const pkg = {
      'meus códigos\\a.ts': "import { b } from './b'\nexport const c = b\n",
      'meus códigos\\b.ts': 'export const b = 1\n'
    }
    const worker = workerFor(pkg, {})
    const defs = await worker.getDefinitionAtPosition(uriOf('meus códigos\\a.ts'), pkg['meus códigos\\a.ts'].lastIndexOf('b'))
    expect((defs ?? []).map(relOf)).toEqual(['meus códigos\\b.ts'])
  })
})

describe('o que vai para o worker', () => {
  it('só código do projeto, sem dependências, saída de build nem minificado', () => {
    const files = [
      'src\\a.ts',
      'src\\b.tsx',
      'scripts\\c.mjs',
      'README.md',
      'node_modules\\react\\index.js',
      'dist\\main.js',
      'out\\renderer\\index.js',
      'public\\vendor.min.js',
      'src\\tipos.d.ts'
    ]
    expect(navCandidates(files, 'src\\a.ts').sort()).toEqual(['scripts\\c.mjs', 'src\\a.ts', 'src\\b.tsx', 'src\\tipos.d.ts'])
  })

  it('com o teto estourado ficam os mais próximos do arquivo aberto', () => {
    const far = Array.from({ length: MAX_NAV_FILES }, (_, i) => `outro\\modulo\\f${i}.ts`)
    const near = ['src\\ui\\perto.ts', 'src\\ui\\sub\\filho.ts']
    const picked = navCandidates([...far, ...near], 'src\\ui\\App.tsx')
    expect(picked).toHaveLength(MAX_NAV_FILES)
    expect(picked.slice(0, 2)).toEqual(['src\\ui\\perto.ts', 'src\\ui\\sub\\filho.ts'])
  })

  it('reconhece tsconfig e jsconfig com sufixo, fora de node_modules', () => {
    expect(['tsconfig.json', 'tsconfig.web.json', 'apps\\x\\jsconfig.json', 'node_modules\\y\\tsconfig.json', 'tsconfig.ts'].filter(isTsconfig)).toEqual([
      'tsconfig.json',
      'tsconfig.web.json',
      'apps\\x\\jsconfig.json'
    ])
  })

  it('JSON com comentário e vírgula sobrando, sem mexer em "//" dentro de texto', () => {
    expect(parseJsonc('{ "url": "https://x.dev/*a*/", // c\n "b": [1,], }')).toEqual({ url: 'https://x.dev/*a*/', b: [1] })
    expect(parseJsonc('{ quebrado')).toBeNull()
  })

  it('a URI do arquivo volta para o caminho relativo da aba; de outro projeto, não', () => {
    expect(relFromUriPath(PROJECT, URI.parse(uriOf('src\\a b\\ç.ts')).path)).toBe('src\\a b\\ç.ts')
    expect(relFromUriPath('outro', URI.parse(uriOf('src\\a.ts')).path)).toBeNull()
  })
})
