import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  browserCommandFor,
  createEntry,
  defaultBrowserTemplate,
  parseRegValue,
  renameEntry,
  treeStamp,
  undoTreeStep,
  validateEntryName
} from '../src/main/file-actions'
import { copyEntries, copyInto, copyItem, MoveConflictError, moveEntry } from '../src/main/files'
import { chooseTrashed, findTrashed, realLocation, recycleBinRoots } from '../src/main/recycle-bin'
import { opensInBrowser } from '../src/shared/browser-viewable'

describe('criar arquivo/pasta pelo explorador', () => {
  it('cria arquivo vazio e pasta dentro da pasta escolhida', () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-create-'))
    createEntry(root, '', 'src', 'dir')
    const { rel } = createEntry(root, 'src', 'índice.ts', 'file')
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

describe('criar com caminho aninhado', () => {
  const setup = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'kora-nested-'))
    mkdirSync(join(root, '.git'))
    return root
  }

  it('falha na criação final apaga as pastas intermediárias que ela criou e mantém as que já existiam', () => {
    const root = setup()
    mkdirSync(join(root, 'ja'))
    // Nome de 300 caracteres passa na validação, mas o Windows recusa na hora de gravar (limite de 255 por nome).
    expect(() => createEntry(root, '', `ja/novo/sub/${'x'.repeat(300)}.ts`, 'file')).toThrow()
    expect(readdirSync(root).sort()).toEqual(['.git', 'ja'])
    expect(readdirSync(join(root, 'ja'))).toEqual([])
  })

  it('cria as pastas que faltam, com / ou \\, e diz qual foi a primeira criada', () => {
    const root = setup()
    expect(createEntry(root, '', 'a/b\\c.ts', 'file')).toEqual({ rel: join('a', 'b', 'c.ts'), top: 'a' })
    expect(statSync(join(root, 'a', 'b', 'c.ts')).size).toBe(0)
    expect(createEntry(root, 'a', 'b/d/e', 'dir')).toEqual({ rel: join('a', 'b', 'd', 'e'), top: join('a', 'b', 'd') })
    expect(statSync(join(root, 'a', 'b', 'd', 'e')).isDirectory()).toBe(true)
    expect(createEntry(root, '', 'a//x.ts/', 'file').rel).toBe(join('a', 'x.ts'))
  })

  it('não sobrescreve e não deixa pasta solta quando recusa', () => {
    const root = setup()
    createEntry(root, '', 'a/b/c.ts', 'file')
    expect(() => createEntry(root, '', 'a/b/c.ts', 'file')).toThrow(/Já existe "c.ts" em "a\/b"/)
    expect(() => createEntry(root, '', 'a/b/C.TS/x', 'file')).toThrow(/é um arquivo/)
    expect(() => createEntry(root, '', 'novo/con/x.ts', 'file')).toThrow(/reservado/)
    expect(() => createEntry(root, '', 'novo/ok/x.', 'file')).toThrow(/ponto ou espaço/)
    expect(() => createEntry(root, '', 'novo/a*b/x', 'file')).toThrow(/não pode conter/)
    expect(existsSync(join(root, 'novo'))).toBe(false)
  })

  it('recusa .., caminho absoluto e .git', () => {
    const root = setup()
    const escape = `fora-${Date.now()}`
    expect(() => createEntry(root, '', `a/../../${escape}.ts`, 'file')).toThrow(/"\.\."/)
    expect(() => createEntry(root, '', `../${escape}.ts`, 'file')).toThrow(/"\.\."/)
    expect(() => createEntry(root, '', 'C:\\x.ts', 'file')).toThrow(/letra de unidade/)
    expect(() => createEntry(root, '', 'x:y.ts', 'file')).toThrow(/^O nome não pode conter :/)
    expect(() => createEntry(root, '', '/x.ts', 'file')).toThrow(/barra/)
    expect(() => createEntry(root, '', '\\\\servidor\\x.ts', 'file')).toThrow(/barra/)
    expect(() => createEntry(root, '', '.git/hooks/pre-commit', 'file')).toThrow(/\.git/)
    expect(existsSync(join(root, '.git', 'hooks'))).toBe(false)
    expect(existsSync(join(root, 'a'))).toBe(false)
    expect(existsSync(join(root, '..', `${escape}.ts`))).toBe(false)
  })
})

describe('copiar e colar dentro do projeto', () => {
  const setup = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'kora-copy-'))
    mkdirSync(join(root, 'src', 'lib'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'index')
    writeFileSync(join(root, 'src', 'lib', 'util.ts'), 'util')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'index.ts'), 'outro')
    mkdirSync(join(root, '.git'))
    return root
  }

  it('copia pasta com tudo dentro, e o original fica', async () => {
    const root = setup()
    expect(await copyEntries(root, ['src'], 'docs')).toEqual([join('docs', 'src')])
    expect(readFileSync(join(root, 'docs', 'src', 'lib', 'util.ts'), 'utf8')).toBe('util')
    expect(readFileSync(join(root, 'src', 'lib', 'util.ts'), 'utf8')).toBe('util')
  })

  it('na mesma pasta ou com nome repetido vira "nome (2)", sem sobrescrever', async () => {
    const root = setup()
    expect(await copyEntries(root, [join('src', 'index.ts')], 'src')).toEqual([join('src', 'index (2).ts')])
    expect(await copyEntries(root, [join('src', 'index.ts')], 'src')).toEqual([join('src', 'index (3).ts')])
    expect(await copyEntries(root, [join('src', 'index.ts')], 'docs')).toEqual([join('docs', 'index (2).ts')])
    expect(readFileSync(join(root, 'docs', 'index.ts'), 'utf8')).toBe('outro')
    expect(readFileSync(join(root, 'docs', 'index (2).ts'), 'utf8')).toBe('index')
    expect(await copyEntries(root, ['src'], '')).toEqual(['src (2)'])
    expect(readFileSync(join(root, 'src (2)', 'lib', 'util.ts'), 'utf8')).toBe('util')
  })

  it('recusa colar uma pasta dentro dela mesma, sem copiar nada da lista', async () => {
    const root = setup()
    await expect(copyEntries(root, [join('docs', 'index.ts'), 'src'], join('src', 'lib'))).rejects.toThrow(/dentro dela mesma/)
    await expect(copyEntries(root, ['src'], 'src')).rejects.toThrow(/dentro dela mesma/)
    expect(readdirSync(join(root, 'src', 'lib'))).toEqual(['util.ts'])
    expect(readdirSync(join(root, 'src')).sort()).toEqual(['index.ts', 'lib'])
  })

  it('recusa .git, raiz, fora do projeto e item sumido', async () => {
    const root = setup()
    await expect(copyEntries(root, ['.git'], 'docs')).rejects.toThrow(/\.git/)
    await expect(copyEntries(root, ['src'], '.git')).rejects.toThrow(/\.git/)
    await expect(copyEntries(root, [''], 'docs')).rejects.toThrow(/raiz/)
    await expect(copyEntries(root, ['../fora'], 'docs')).rejects.toThrow(/fora do projeto/)
    await expect(copyEntries(root, ['sumiu.ts'], 'docs')).rejects.toThrow(/^ENOENT/)
  })

  it('duas colagens ao mesmo tempo ganham nomes diferentes', async () => {
    const root = setup()
    const both = await Promise.all([copyEntries(root, [join('src', 'index.ts')], 'src'), copyEntries(root, [join('src', 'index.ts')], 'src')])
    expect(both.flat().sort()).toEqual([join('src', 'index (2).ts'), join('src', 'index (3).ts')])
    expect(readFileSync(join(root, 'src', 'index (3).ts'), 'utf8')).toBe('index')
  })

  it('nome livre tomado por outro programa no meio da colagem: falha e o arquivo dele fica', async () => {
    const root = setup()
    const agentTakesTheName = async (source: string, target: string): Promise<void> => {
      writeFileSync(target, 'do agente')
      await copyItem(source, target)
    }
    await expect(copyInto(root, [join(root, 'src', 'index.ts')], 'src', 'duplicate', agentTakesTheName)).rejects.toThrow()
    expect(readFileSync(join(root, 'src', 'index (2).ts'), 'utf8')).toBe('do agente')
  })
})

// Quantas voltas o laço de eventos dá enquanto o trabalho roda: trabalho síncrono no main (cpSync, lstatSync numa
// árvore grande) não deixa nenhuma, e nesse tempo os terminais e a janela ficam parados.
async function loopTurnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0
  let running = true
  const spin = (): void => {
    turns++
    if (running) setImmediate(spin)
  }
  setImmediate(spin)
  try {
    await work()
  } finally {
    running = false
  }
  return turns
}

describe('colar pasta grande sem travar o app', () => {
  const bigFolder = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'kora-big-'))
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(root, 'grande', `sub${d}`), { recursive: true })
      for (let f = 0; f < 20; f++) writeFileSync(join(root, 'grande', `sub${d}`, `f${f}.txt`), `${d}-${f}`)
    }
    return root
  }

  it('a cópia deixa o processo responder no meio e chega inteira', async () => {
    const root = bigFolder()
    let copied: string[] = []
    const turns = await loopTurnsDuring(async () => {
      copied = await copyEntries(root, ['grande'], '')
    })
    expect(copied).toEqual(['grande (2)'])
    expect(readFileSync(join(root, 'grande (2)', 'sub19', 'f19.txt'), 'utf8')).toBe('19-19')
    expect(turns).toBeGreaterThan(20)
  })

  it('o retrato da pasta colada também', async () => {
    const root = bigFolder()
    const turns = await loopTurnsDuring(() => treeStamp(root, 'grande'))
    expect(turns).toBeGreaterThan(20)
  })
})

describe('desfazer na árvore', () => {
  const setup = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'kora-undo-'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'a.txt'), 'a')
    return root
  }
  const remove = async (abs: string): Promise<void> => rmSync(abs, { recursive: true })

  const stamped = (root: string, rels: string[]): Promise<{ rel: string; stamp: string }[]> =>
    Promise.all(rels.map(async (rel) => ({ rel, stamp: await treeStamp(root, rel) })))
  const busy = (rel: string): Error => Object.assign(new Error(`EBUSY: resource busy or locked, ${rel}`), { code: 'EBUSY' })

  it('apaga o que foi criado, levando as pastas intermediárias', async () => {
    const root = setup()
    const { top } = createEntry(root, '', 'novo/sub/x.ts', 'file')
    const result = await undoTreeStep(root, { kind: 'remove', items: await stamped(root, [top]) }, remove)
    expect(result).toEqual({ moved: [], message: null, remaining: null })
    expect(existsSync(join(root, 'novo'))).toBe(false)
  })

  it('não apaga o que mudou depois de criado ou colado', async () => {
    const root = setup()
    const { top } = createEntry(root, '', 'novo/x.ts', 'file')
    const stamp = await treeStamp(root, top)
    writeFileSync(join(root, 'novo', 'x.ts'), 'trabalho do agente')
    const result = await undoTreeStep(root, { kind: 'remove', items: [{ rel: top, stamp }] }, remove)
    expect(result.message).toMatch(/foi alterado depois/)
    expect(readFileSync(join(root, 'novo', 'x.ts'), 'utf8')).toBe('trabalho do agente')

    const [copy] = await copyEntries(root, ['docs'], '')
    const copyStamp = await treeStamp(root, copy!)
    writeFileSync(join(root, copy!, 'novo.md'), '')
    const again = await undoTreeStep(root, { kind: 'remove', items: [{ rel: copy!, stamp: copyStamp }] }, remove)
    expect(again.message).toMatch(/alterado/)
    expect(existsSync(join(root, copy!, 'novo.md'))).toBe(true)
  })

  it('agente salva o 2º item enquanto o 1º vai para a Lixeira: o 2º fica, com o trabalho novo', async () => {
    const root = setup()
    const copies = await copyEntries(root, ['a.txt', 'docs'], '')
    const items = await stamped(root, copies)
    let first = true
    const trashWhileAgentSaves = async (abs: string): Promise<void> => {
      rmSync(abs, { recursive: true })
      if (first) writeFileSync(join(root, copies[1]!, 'novo.md'), 'trabalho do agente')
      first = false
    }
    const result = await undoTreeStep(root, { kind: 'remove', items }, trashWhileAgentSaves)
    expect(result.message).toMatch(/foi alterado depois/)
    expect(result.remaining).toEqual({ kind: 'remove', items: [items[1]] })
    expect(existsSync(join(root, copies[0]!))).toBe(false)
    expect(readFileSync(join(root, copies[1]!, 'novo.md'), 'utf8')).toBe('trabalho do agente')
  })

  it('falha no meio (arquivo travado) devolve só o que faltou, e esse resto desfaz depois', async () => {
    const root = setup()
    const rels = ['x1.txt', 'x2.txt', 'x3.txt'].map((name) => createEntry(root, '', name, 'file').top)
    const items = await stamped(root, rels)
    let calls = 0
    const busyOnSecond = async (abs: string): Promise<void> => {
      if (++calls === 2) throw busy(abs)
      rmSync(abs)
    }
    const result = await undoTreeStep(root, { kind: 'remove', items }, busyOnSecond)
    expect(result.message).toMatch(/^"x2\.txt": EBUSY/)
    expect(result.remaining).toEqual({ kind: 'remove', items: items.slice(1) })
    expect(rels.map((rel) => existsSync(join(root, rel)))).toEqual([false, true, true])

    expect(await undoTreeStep(root, result.remaining!, remove)).toEqual({ moved: [], message: null, remaining: null })
    expect(readdirSync(root).sort()).toEqual(['a.txt', 'docs'])
  })

  it('recusa sem mexer em nada quando um item já mudou antes de começar', async () => {
    const root = setup()
    const rels = ['x1.txt', 'x2.txt'].map((name) => createEntry(root, '', name, 'file').top)
    const items = await stamped(root, rels)
    writeFileSync(join(root, 'x2.txt'), 'mudou')
    const step = { kind: 'remove' as const, items }
    const result = await undoTreeStep(root, step, remove)
    expect(result.message).toMatch(/"x2\.txt" foi alterado/)
    expect(result.remaining).toEqual(step)
    expect(existsSync(join(root, 'x1.txt'))).toBe(true)
  })

  // Pasta que é o diretório atual de outro processo não pode ser renomeada no Windows: um EBUSY/EPERM de verdade.
  it.runIf(process.platform === 'win32')('mover de volta com pasta travada no meio: o que voltou fica, o resto tenta depois', async () => {
    const root = setup()
    mkdirSync(join(root, 'pasta', 'sub'), { recursive: true })
    const movedFile = moveEntry(root, 'a.txt', 'docs')
    const movedDir = moveEntry(root, 'pasta', 'docs')
    const step = { kind: 'move' as const, moves: [{ from: 'a.txt', to: movedFile }, { from: 'pasta', to: movedDir }] }
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: join(root, movedDir, 'sub'), stdio: 'ignore' })
    let result: Awaited<ReturnType<typeof undoTreeStep>>
    try {
      result = await undoTreeStep(root, step, remove)
    } finally {
      holder.kill()
      await once(holder, 'exit')
    }
    expect(result.moved).toEqual([{ from: movedFile, to: 'a.txt' }])
    expect(result.message).toMatch(/^"pasta": E(BUSY|PERM|ACCES)/)
    expect(result.remaining).toEqual({ kind: 'move', moves: [{ from: 'pasta', to: movedDir }] })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a')

    const retry = await undoTreeStep(root, result.remaining!, remove)
    expect(retry).toEqual({ moved: [{ from: movedDir, to: 'pasta' }], message: null, remaining: null })
    expect(existsSync(join(root, 'pasta', 'sub'))).toBe(true)
  })

  it('leva de volta o que foi renomeado ou movido', async () => {
    const root = setup()
    const renamed = renameEntry(root, 'a.txt', 'b.txt')
    const moved = moveEntry(root, renamed, 'docs')
    const back = await undoTreeStep(root, { kind: 'move', moves: [{ from: renamed, to: moved }] }, remove)
    expect(back).toEqual({ moved: [{ from: join('docs', 'b.txt'), to: 'b.txt' }], message: null, remaining: null })
    await undoTreeStep(root, { kind: 'move', moves: [{ from: 'a.txt', to: renamed }] }, remove)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a')
    expect(readdirSync(root).sort()).toEqual(['a.txt', 'docs'])
  })

  it('não leva de volta por cima de outro item nem para pasta que sumiu', async () => {
    const root = setup()
    const moved = moveEntry(root, 'a.txt', 'docs')
    writeFileSync(join(root, 'a.txt'), 'outro')
    const result = await undoTreeStep(root, { kind: 'move', moves: [{ from: 'a.txt', to: moved }] }, remove)
    expect(result.message).toMatch(/Já existe outro "a.txt"/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('outro')
    expect(readFileSync(join(root, moved), 'utf8')).toBe('a')

    mkdirSync(join(root, 'sai'))
    const inner = moveEntry(root, moved, 'sai')
    rmSync(join(root, 'docs'), { recursive: true })
    const gone = await undoTreeStep(root, { kind: 'move', moves: [{ from: moved, to: inner }] }, remove)
    expect(gone.message).toMatch(/não existe mais/)
    expect(existsSync(join(root, inner))).toBe(true)
  })

  it('só troca maiúsculas de volta, mesmo o Windows vendo o mesmo item', async () => {
    const root = setup()
    const renamed = renameEntry(root, 'a.txt', 'A.txt')
    await undoTreeStep(root, { kind: 'move', moves: [{ from: 'a.txt', to: renamed }] }, remove)
    expect(readdirSync(root)).toContain('a.txt')
  })
})

// Usa a Lixeira de verdade deste Windows; o runner do CI não tem um shell de usuário com Lixeira garantida.
describe.skipIf(process.platform !== 'win32' || process.env['CI'])('desfazer exclusão pela Lixeira do Windows', () => {
  const recycle = (abs: string): void => {
    const kind = statSync(abs).isDirectory() ? 'DeleteDirectory' : 'DeleteFile'
    const quoted = abs.replace(/'/g, "''")
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}('${quoted}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
    ])
  }
  const noTrash = async (): Promise<void> => {
    throw new Error('não deveria apagar')
  }

  it('restaura arquivo e pasta excluídos para o lugar de antes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-lixeira-'))
    mkdirSync(join(root, 'pasta com espaço', 'dentro'), { recursive: true })
    writeFileSync(join(root, 'pasta com espaço', 'dentro', 'x.md'), 'x')
    writeFileSync(join(root, 'relatório.txt'), 'conteúdo')
    const since = Date.now()
    recycle(join(root, 'relatório.txt'))
    recycle(join(root, 'pasta com espaço'))
    expect(readdirSync(root)).toEqual([])
    const step = {
      kind: 'restore' as const,
      items: [
        { rel: 'relatório.txt', since },
        { rel: 'pasta com espaço', since }
      ]
    }
    expect(await undoTreeStep(root, step, noTrash)).toEqual({ moved: [], message: null, remaining: null })
    expect(readFileSync(join(root, 'relatório.txt'), 'utf8')).toBe('conteúdo')
    expect(readFileSync(join(root, 'pasta com espaço', 'dentro', 'x.md'), 'utf8')).toBe('x')
    expect((await undoTreeStep(root, step, noTrash)).message).toMatch(/Já existe outro/)
  })

  it('entre várias exclusões do mesmo caminho, devolve a da vez certa', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-lixeira-'))
    const since: number[] = []
    for (const content of ['primeiro', 'segundo', 'terceiro']) {
      if (since.length) await new Promise((resolve) => setTimeout(resolve, 1500))
      writeFileSync(join(root, 'a.txt'), content)
      since.push(Date.now())
      recycle(join(root, 'a.txt'))
    }
    const restore = (at: number): Promise<unknown> => undoTreeStep(root, { kind: 'restore', items: [{ rel: 'a.txt', since: at }] }, noTrash)
    await restore(since[1]!)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('segundo')
    renameSync(join(root, 'a.txt'), join(root, '2.txt'))
    await restore(since[2]!)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('terceiro')
    renameSync(join(root, 'a.txt'), join(root, '3.txt'))
    await restore(since[0]!)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('primeiro')
  })

  it('diz que não está mais na Lixeira quando ela já foi restaurada ou esvaziada', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-lixeira-'))
    const result = await undoTreeStep(root, { kind: 'restore', items: [{ rel: 'nunca-existiu.txt', since: Date.now() }] }, noTrash)
    expect(result.message).toMatch(/não está mais na Lixeira/)
  })

  it('falha no meio da restauração: o que voltou fica, o resto continua na Lixeira e volta depois', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-lixeira-'))
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'pasta', 'sub'), { recursive: true })
    const since = Date.now()
    recycle(join(root, 'a.txt'))
    recycle(join(root, 'pasta'))
    const step = { kind: 'restore' as const, items: [{ rel: 'a.txt', since }, { rel: 'pasta', since }] }
    // A pasta dentro da Lixeira vira o diretório atual de outro processo: o Windows recusa renomeá-la de volta.
    const inBin = findTrashed(join(root, 'pasta'), since)!.data
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: join(inBin, 'sub'), stdio: 'ignore' })
    let result: Awaited<ReturnType<typeof undoTreeStep>>
    try {
      result = await undoTreeStep(root, step, noTrash)
    } finally {
      holder.kill()
      await once(holder, 'exit')
    }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a')
    expect(result.message).toMatch(/^"pasta": /)
    expect(result.remaining).toEqual({ kind: 'restore', items: [{ rel: 'pasta', since }] })
    expect(existsSync(join(root, 'pasta'))).toBe(false)

    expect(await undoTreeStep(root, result.remaining!, noTrash)).toEqual({ moved: [], message: null, remaining: null })
    expect(existsSync(join(root, 'pasta', 'sub'))).toBe(true)
  })
})

describe.runIf(process.platform === 'win32')('Lixeira do volume onde o projeto está de fato', () => {
  it('caminho por uma junção resolve para a pasta real', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-juncao-')))
    mkdirSync(join(base, 'real'))
    symlinkSync(join(base, 'real'), join(base, 'link'), 'junction')
    expect(realLocation(join(base, 'link', 'a.txt')).toLowerCase()).toBe(join(base, 'real', 'a.txt').toLowerCase())
    expect(realLocation(join(base, 'link', 'sumiu', 'a.txt'))).toBe(join(base, 'link', 'sumiu', 'a.txt'))
  })

  // Precisa de um segundo volume NTFS gravável (ex.: KORA_TEST_OTHER_VOLUME=D:\). Cria e apaga uma pasta nele e usa a
  // Lixeira de verdade; fora do CI e só quando pedido.
  const other = process.env['KORA_TEST_OTHER_VOLUME']
  it.runIf(other && !process.env['CI'])('projeto aberto por junção em C: com o conteúdo em outro volume desfaz a exclusão', async () => {
    const real = mkdtempSync(join(other!, 'kora-juncao-'))
    const link = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'kora-juncao-'))), 'projeto')
    symlinkSync(real, link, 'junction')
    try {
      writeFileSync(join(link, 'a.txt'), 'no outro volume')
      expect(recycleBinRoots(join(link, 'a.txt'))[0]!.toLowerCase()).toBe(parse(real).root.toLowerCase())
      const since = Date.now()
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${join(link, 'a.txt').replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
      ])
      const result = await undoTreeStep(link, { kind: 'restore', items: [{ rel: 'a.txt', since }] }, async () => {})
      expect(result).toEqual({ moved: [], message: null, remaining: null })
      expect(readFileSync(join(real, 'a.txt'), 'utf8')).toBe('no outro volume')
    } finally {
      rmSync(link)
      rmSync(real, { recursive: true, force: true })
    }
  })
})

describe('abrir no navegador padrão só o que ele mostra', () => {
  it('html, pdf, svg, imagens, json, txt e xml sim; docx, zip, mp4, bin e md não', () => {
    for (const yes of ['index.html', 'a.HTM', 'doc\\guia.pdf', 'logo.svg', 'foto.jpeg', 'dados.json', 'notas.txt', 'feed.xml']) {
      expect(opensInBrowser(yes), yes).toBe(true)
    }
    for (const no of ['carta.docx', 'pacote.zip', 'video.mp4', 'firmware.bin', 'README.md', 'html', '.json', 'Makefile']) {
      expect(opensInBrowser(no), no).toBe(false)
    }
  })
})

describe('qual exclusão da Lixeira é a desfeita', () => {
  const since = 1_000_000

  it('é a primeira excluída a partir do momento marcado, mesmo com uma anterior do mesmo caminho logo antes', () => {
    const anterior = { deletedMs: since - 500, v: 'anterior' }
    const esta = { deletedMs: since + 30, v: 'esta' }
    const seguinte = { deletedMs: since + 5_000, v: 'seguinte' }
    expect(chooseTrashed([seguinte, anterior, esta], since)?.v).toBe('esta')
  })

  it('sem nenhuma depois do momento, aceita arredondamento e fica com a mais recente da folga', () => {
    expect(chooseTrashed([{ deletedMs: since - 800, v: 'a' }, { deletedMs: since - 20, v: 'b' }], since)?.v).toBe('b')
    expect(chooseTrashed([{ deletedMs: since - 5_000, v: 'velha' }], since)).toBeNull()
  })
})
