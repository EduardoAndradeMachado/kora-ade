import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ICON_BYTES,
  findProjectIcon,
  githubAvatarUrl,
  parseGithubOwner,
  sniffImageMime
} from '../src/main/project-icon'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-corpo')])
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const svg = (id: string): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" id="${id}"></svg>`)

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kora-icon-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(rel: string, content: Buffer | string): void {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function decode(dataUrl: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!m) throw new Error(`data URL inválida: ${dataUrl.slice(0, 40)}`)
  return { mime: m[1] ?? '', bytes: Buffer.from(m[2] ?? '', 'base64') }
}

describe('layouts reais de projeto', () => {
  it('Next.js: app/icon.png vence public/favicon.ico e volta com os bytes do arquivo', async () => {
    put('app/icon.png', PNG)
    put('public/favicon.ico', ICO)

    const icon = await findProjectIcon(root)

    expect(icon?.source).toBe('app/icon.png')
    const { mime, bytes } = decode(icon?.dataUrl ?? '')
    expect(mime).toBe('image/png')
    expect(bytes.equals(PNG)).toBe(true)
  })

  it('Next.js com src/: só src/app/favicon.ico vira image/x-icon', async () => {
    put('src/app/favicon.ico', ICO)
    put('src/app/icon.tsx', 'export default function Icon() {}')

    const icon = await findProjectIcon(root)

    expect(icon?.source).toBe('src/app/favicon.ico')
    expect(decode(icon?.dataUrl ?? '').mime).toBe('image/x-icon')
  })

  it('Vite: public/favicon.svg vence o vite.svg do template', async () => {
    put('public/vite.svg', svg('vite'))
    put('public/favicon.svg', svg('projeto'))

    const icon = await findProjectIcon(root)

    expect(icon?.source).toBe('public/favicon.svg')
    const { mime, bytes } = decode(icon?.dataUrl ?? '')
    expect(mime).toBe('image/svg+xml')
    expect(bytes.toString()).toContain('id="projeto"')
  })

  it('Vite recém-criado (só vite.svg, referenciado no index.html) não tem logo', async () => {
    put('public/vite.svg', svg('vite'))
    put('index.html', '<link rel="icon" type="image/svg+xml" href="/vite.svg" />')

    expect(await findProjectIcon(root)).toBeNull()
  })

  it('projeto sem nada devolve null', async () => {
    put('package.json', '{}')
    put('src/index.ts', 'x')

    expect(await findProjectIcon(root)).toBeNull()
  })

  it('Electron: build/icon.png é achado quando não há favicon', async () => {
    put('build/icon.png', PNG)

    expect((await findProjectIcon(root))?.source).toBe('build/icon.png')
  })
})

describe('ordem de prioridade', () => {
  it('no mesmo nome, svg vem antes de png e de ico', async () => {
    put('public/favicon.ico', ICO)
    put('public/favicon.png', PNG)
    put('public/favicon.svg', svg('a'))

    expect((await findProjectIcon(root))?.source).toBe('public/favicon.svg')
  })

  it('favicon vem antes de logo, mesmo com logo em formato melhor', async () => {
    put('public/logo.svg', svg('logo'))
    put('public/favicon.ico', ICO)

    expect((await findProjectIcon(root))?.source).toBe('public/favicon.ico')
  })

  it('public/favicon vem antes do favicon da raiz', async () => {
    put('favicon.png', PNG)
    put('public/favicon.png', PNG)

    expect((await findProjectIcon(root))?.source).toBe('public/favicon.png')
  })

  it('apple-touch-icon só entra quando não há favicon nem icon', async () => {
    put('public/apple-touch-icon.png', PNG)
    put('public/logo.png', PNG)

    expect((await findProjectIcon(root))?.source).toBe('public/apple-touch-icon.png')
  })
})

describe('mime pelo conteúdo, não pela extensão', () => {
  it('favicon.png que na verdade é JPEG sai como image/jpeg', async () => {
    put('public/favicon.png', JPEG)

    expect(decode((await findProjectIcon(root))?.dataUrl ?? '').mime).toBe('image/jpeg')
  })

  it('webp é reconhecido', async () => {
    put('public/icon.webp', WEBP)

    expect(decode((await findProjectIcon(root))?.dataUrl ?? '').mime).toBe('image/webp')
  })

  it('arquivo com nome de ícone mas conteúdo lixo é pulado e o próximo candidato vale', async () => {
    put('public/favicon.ico', 'isto não é imagem')
    put('public/logo.png', PNG)

    expect((await findProjectIcon(root))?.source).toBe('public/logo.png')
  })

  it('svg com prólogo xml e comentário é reconhecido; html não é', () => {
    expect(sniffImageMime(Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- x -->\n<svg viewBox="0 0 1 1"/>'))).toBe(
      'image/svg+xml'
    )
    expect(sniffImageMime(Buffer.from('<html><svg></svg></html>'))).toBeNull()
  })
})

describe('limite de tamanho', () => {
  const pngOf = (size: number): Buffer => Buffer.concat([PNG, Buffer.alloc(size - PNG.length)])

  it('ícone acima do limite é pulado em favor do próximo', async () => {
    put('public/favicon.png', pngOf(MAX_ICON_BYTES + 1))
    put('public/logo.svg', svg('logo'))

    expect((await findProjectIcon(root))?.source).toBe('public/logo.svg')
  })

  it('só um ícone grande demais → null', async () => {
    put('public/favicon.png', pngOf(MAX_ICON_BYTES + 1))

    expect(await findProjectIcon(root)).toBeNull()
  })

  it('exatamente no limite ainda vale', async () => {
    put('public/favicon.png', pngOf(MAX_ICON_BYTES))

    expect((await findProjectIcon(root))?.source).toBe('public/favicon.png')
  })
})

describe('pastas ignoradas', () => {
  it('favicon dentro de node_modules, dist, out e .next não conta', async () => {
    put('node_modules/public/favicon.png', PNG)
    put('node_modules/pacote/public/favicon.png', PNG)
    put('dist/public/favicon.png', PNG)
    put('out/app/icon.png', PNG)
    put('.next/app/icon.png', PNG)

    expect(await findProjectIcon(root)).toBeNull()
  })

  it('index.html apontando para node_modules é recusado', async () => {
    put('node_modules/pacote/favicon.png', PNG)
    put('index.html', '<link rel="icon" href="node_modules/pacote/favicon.png">')

    expect(await findProjectIcon(root)).toBeNull()
  })

})

describe('link rel=icon do index.html', () => {
  it('usa o caminho declarado quando não há candidato conhecido', async () => {
    put('assets/img/favicon.svg', svg('sobra'))
    put('assets/img/favicon-opt1.svg', svg('usado'))
    put('index.html', '<head><link rel="stylesheet" href="a.css"><link href="assets/img/favicon-opt1.svg" rel="icon"></head>')

    const icon = await findProjectIcon(root)

    expect(icon?.source).toBe('assets/img/favicon-opt1.svg')
  })

  it('href com barra inicial resolve em public/', async () => {
    put('public/brand/marca.png', PNG)
    put('index.html', "<link rel='shortcut icon' href='/brand/marca.png?v=2'>")

    expect((await findProjectIcon(root))?.source).toBe('public/brand/marca.png')
  })

  it('href saindo do projeto ou externo é ignorado', async () => {
    put('index.html', '<link rel="icon" href="../fora.png"><link rel="icon" href="https://x.com/f.png">')
    writeFileSync(join(dirname(root), 'fora.png'), PNG)

    try {
      expect(await findProjectIcon(root)).toBeNull()
    } finally {
      rmSync(join(dirname(root), 'fora.png'), { force: true })
    }
  })
})

describe('monorepo (um nível)', () => {
  it('apps/web/app/icon.svg é achado', async () => {
    put('apps/web/app/icon.svg', svg('web'))
    put('package.json', '{}')

    expect((await findProjectIcon(root))?.source).toBe('apps/web/app/icon.svg')
  })

  it('entre pastas irmãs vence o candidato de maior prioridade, não a primeira em ordem alfabética', async () => {
    put('loja-admin/src/app/favicon.ico', ICO)
    put('loja-app/src/app/icon.png', PNG)

    expect((await findProjectIcon(root))?.source).toBe('loja-app/src/app/icon.png')
  })

  it('ícone da raiz vence o de subprojeto', async () => {
    put('public/favicon.ico', ICO)
    put('apps/web/app/icon.svg', svg('web'))

    expect((await findProjectIcon(root))?.source).toBe('public/favicon.ico')
  })
})

describe('owner do GitHub a partir do remote', () => {
  it.each([
    ['https://github.com/journeyengage/kora-ade.git', 'journeyengage'],
    ['https://github.com/EduardoAndradeMachado/kora-ade', 'EduardoAndradeMachado'],
    ['https://token@github.com/owner-x/repo', 'owner-x'],
    ['https://www.GitHub.com/Owner/repo/', 'Owner'],
    ['git@github.com:journeyengage/tasksjourneyengage-app.git', 'journeyengage'],
    ['ssh://git@github.com/owner/repo.git', 'owner'],
    ['ssh://git@github.com:22/owner/repo.git', 'owner'],
    ['  git@github.com:owner/repo.git\n', 'owner']
  ])('%s → %s', (remote, owner) => {
    expect(parseGithubOwner(remote)).toBe(owner)
  })

  it.each([
    'https://gitlab.com/owner/repo.git',
    'git@gitlab.com:owner/repo.git',
    'git@bitbucket.org:owner/repo.git',
    'https://github.com.evil.com/owner/repo',
    'https://evilgithub.com/owner/repo',
    'git@github.com.evil.com:owner/repo.git',
    'https://github.com/owner',
    'https://github.com/-owner/repo',
    'file:///C:/repos/x.git',
    'C:/repos/x',
    ''
  ])('%s → null', (remote) => {
    expect(parseGithubOwner(remote)).toBeNull()
  })
})

describe('githubAvatarUrl com repo git real', () => {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
  }

  it('remote https do GitHub vira URL do avatar do owner', async () => {
    git('init', '-q')
    git('remote', 'add', 'origin', 'https://github.com/journeyengage/kora-ade.git')

    expect(await githubAvatarUrl(root)).toBe('https://github.com/journeyengage.png?size=64')
  })

  it('remote ssh do GitHub também', async () => {
    git('init', '-q')
    git('remote', 'add', 'origin', 'git@github.com:EduardoAndradeMachado/repo.git')

    expect(await githubAvatarUrl(root)).toBe('https://github.com/EduardoAndradeMachado.png?size=64')
  })

  it('remote de outro provedor → null', async () => {
    git('init', '-q')
    git('remote', 'add', 'origin', 'https://gitlab.com/journeyengage/kora-ade.git')

    expect(await githubAvatarUrl(root)).toBeNull()
  })

  it('usa o origin, não outro remote do GitHub', async () => {
    git('init', '-q')
    git('remote', 'add', 'upstream', 'https://github.com/outro/repo.git')
    git('remote', 'add', 'origin', 'https://gitlab.com/eu/repo.git')

    expect(await githubAvatarUrl(root)).toBeNull()
  })

  it('repo sem remote → null', async () => {
    git('init', '-q')

    expect(await githubAvatarUrl(root)).toBeNull()
  })
})
