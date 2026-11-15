import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './harness'
import { git, isAlive, newTab, seedRepo, typeLine, ui, waitFor, type KoraRun } from './kora'

const panelOf = (run: KoraRun) => run.page.locator('aside').last()
const row = (run: KoraRun, rel: string) => panelOf(run).locator(`div[data-tip="${rel.replaceAll('\\', '\\\\')}"]`)

// O shell da aba grava um arquivo no projeto: prova que o terminal recebe o que se digita e o PowerShell roda.
async function terminalAlive(run: KoraRun, marker: string): Promise<void> {
  await typeLine(run.page, `Set-Content -Path ${marker}.txt -Value ok`)
  await waitFor(() => existsSync(join(run.env.project, `${marker}.txt`)), `o terminal gravou ${marker}.txt`)
}

test('R88 robustez: Markdown que estoura o desenho fica só na aba dele; terminal, outras abas e edição não salva seguem vivos', async ({ kora }) => {
  const env = kora.env()
  // O lexer do marked é recursivo: citações aninhadas assim estouram a pilha ao desenhar a visualização.
  writeFileSync(join(env.project, 'profundo.md'), `${'>'.repeat(20_000)} x\n`)
  writeFileSync(join(env.project, 'notas.txt'), 'notas\n')
  writeFileSync(
    join(env.project, 'profundo.ipynb'),
    JSON.stringify({ nbformat: 4, metadata: {}, cells: [{ cell_type: 'markdown', source: `${'>'.repeat(20_000)} x` }] })
  )
  const run = await kora.launch(env)
  const page = run.page

  await newTab(page, 'Terminal')
  await terminalAlive(run, 'vivo-antes')

  await row(run, 'notas.txt').dblclick()
  await expect(ui.barTab(page, 'notas.txt')).toBeVisible()
  const editor = page.locator('.monaco-editor').filter({ visible: true })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('linha não salva')

  await row(run, 'profundo.md').dblclick()
  const alert = page.getByRole('alert').filter({ visible: true })
  await expect(alert).toContainText('Não foi possível mostrar esta aba')
  await expect(alert).toContainText('Maximum call stack size exceeded')
  // Recarregar tenta de novo e cai no mesmo aviso, sem levar o resto.
  await alert.getByRole('button', { name: 'Recarregar' }).click()
  await expect(page.getByRole('alert').filter({ visible: true })).toContainText('Não foi possível mostrar esta aba')
  // A visualização caiu com o cabeçalho dela; o aviso é a saída para o editor, que corrige o arquivo.
  await page.getByRole('alert').filter({ visible: true }).getByRole('button', { name: 'Abrir no editor' }).click()
  await expect(page.getByRole('alert').filter({ visible: true })).toHaveCount(0)
  await expect(page.locator('.monaco-editor').filter({ visible: true })).toBeVisible()

  // Visualizador sem limite próprio (notebook): cai o da aba inteira.
  await row(run, 'profundo.ipynb').dblclick()
  await expect(page.getByRole('alert').filter({ visible: true })).toContainText('Maximum call stack size exceeded')

  await ui.barTab(page, 'notas.txt').click()
  await expect(page.locator('.monaco-editor').filter({ visible: true })).toContainText('linha não salva')
  await page.locator('.monaco-editor').filter({ visible: true }).click()
  await page.keyboard.press('Control+s')
  await waitFor(() => readFileSync(join(env.project, 'notas.txt'), 'utf8').includes('linha não salva'), 'a edição da outra aba foi salva')

  await ui.tabBar(page).locator('div.group').first().click()
  await terminalAlive(run, 'vivo-depois')
  expect(isAlive(run.pid)).toBe(true)
})

test('R89 robustez: lixo nos canais de arquivo e git volta como erro, não derruba o main nem escapa do projeto', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  writeFileSync(join(env.project, 'descartavel.txt'), 'x')
  // Alvo fora do projeto, mas dentro da pasta do teste: se a proteção falhar, o estrago fica no teste, não no Windows.
  const sentinel = join(env.root, 'sentinela.txt')
  writeFileSync(sentinel, 'fora do projeto')
  const outside = readdirSync(env.root).sort()
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Terminal')
  await terminalAlive(run, 'vivo-antes')

  const results = await page.evaluate(async (sentinel) => {
    const k = window.kora as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const huge = 'x'.repeat(200_000)
    const calls: [string, ...unknown[]][] = [
      ['listDir', 'p1', null],
      ['listDir', 'p1', '..'],
      ['listDir', 'nao-existe', ''],
      ['listDir', 'p1', '\\\\?\\C:\\'],
      ['listDir', 'p1', 'README.md'],
      ['listDir', 5, {}],
      ['readText', 'p1', 5],
      ['readText', 'p1', '..\\..\\Windows\\win.ini'],
      ['readText', 'p1', 'C:\\Windows\\win.ini'],
      ['readText', 'p1', '\\\\localhost\\C$\\Windows\\win.ini'],
      ['readText', 'p1', 'a\0b'],
      ['readText', 'p1', huge],
      ['readText', 'p1', ''],
      ['readText', 'p1', 'README.md', { encoding: 'klingon' }],
      ['writeText', 'p1', '..\\fora.txt', 'x', 0],
      ['writeText', 'p1', sentinel, 'x', 0],
      ['writeText', 'p1', '\\\\?\\' + sentinel, 'x', 0],
      ['writeText', 'p1', 'tracked.txt', { nao: 'texto' }, 0],
      ['writeText', 'p1', 'tracked.txt', 'x', 'agora'],
      ['writeText', 'p1', '', 'x', 0],
      ['writeText', null, null, null, null, null, null],
      ['createEntry', 'p1', '', '..\\fora.txt', 'file'],
      ['createEntry', 'p1', '..', 'fora.txt', 'file'],
      ['createEntry', 'p1', '', 'con', 'file'],
      ['createEntry', 'p1', '', huge, 'dir'],
      ['createEntry', 'p1', '', 'ok', 'banana'],
      ['moveEntry', 'p1', 'tracked.txt', '..'],
      ['moveEntry', 'p1', '', 'src'],
      ['moveEntry', 'p1', null, null],
      ['renameEntry', 'p1', 'tracked.txt', '..\\fora.txt'],
      ['renameEntry', 'p1', '', 'novo'],
      ['renameEntry', 'p1', 'descartavel.txt', null],
      ['renameEntry', 'p1', 'descartavel.txt', 5],
      ['createEntry', 'p1', '', null, 'file'],
      ['createEntry', 'p1', null, 'x.txt', 'dir'],
      ['moveEntry', 'p1', 'descartavel.txt', null],
      ['copyEntries', 'p1', ['descartavel.txt'], null],
      ['copyEntries', 'p1', null, ''],
      ['copyEntries', 'p1', ['..'], ''],
      ['copyEntries', 'p1', ['src'], '..'],
      ['importEntries', 'p1', [sentinel], '..'],
      ['importEntries', 'p1', sentinel, ''],
      ['undoTreeStep', 'p1', { kind: 'nada' }],
      ['undoTreeStep', 'p1', null],
      ['trashEntry', 'p1', ''],
      ['trashEntry', 'p1', '..'],
      ['trashEntry', 'p1', sentinel],
      ['moveEntry', 'p1', sentinel, ''],
      ['renameEntry', 'p1', sentinel, 'outro.txt'],
      ['fileInfo', 'p1', '..\\..'],
      ['fileExists', 'p1', {}],
      ['searchProject', 'p1', null, 5],
      ['searchProject', 'p1', '('.repeat(500), { regex: true }],
      ['searchProject', 'p1', huge, { include: '..' }],
      ['gitDiff', 'p1', '..\\..\\x', 'sim'],
      ['gitDiff', 'p1', null, null],
      ['gitStage', 'p1', 5],
      ['gitStage', 'p1', ['..\\..\\fora']],
      ['gitDiscard', 'p1', ['..\\..\\fora']],
      ['gitCreateBranch', 'p1', '--force', true],
      ['gitCheckout', 'p1', '-f', null],
      ['gitSetRemote', 'p1', '--upload-pack=calc'],
      ['gitIgnored', 'p1', 'nao-e-lista'],
      ['gitCreateBranch', 'p1', null, false],
      ['gitCreateBranch', 'p1', 7, false],
      ['gitRenameBranch', 'p1', 'main', null],
      ['gitSetRemote', 'p1', null],
      ['gitStage', 'p1', [null]],
      ['gitCommit', 'p1', null, true],
      ['resolveTerminalLink', 'p1', huge]
    ]
    const out: { call: string; outcome: string; escapes: boolean }[] = []
    for (const [name, ...args] of calls) {
      const timeout = new Promise<string>((done) => setTimeout(() => done('sem resposta'), 15_000))
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() => k[name]!(...args))
          .then(
            (value) => `ok ${JSON.stringify(value)?.slice(0, 80)}`,
            (err: unknown) => `erro ${String((err as Error)?.message ?? err).slice(0, 160)}`
          ),
        timeout
      ])
      const escapes = JSON.stringify(args).includes('sentinela') || /fora|\.\./.test(JSON.stringify(args))
      out.push({ call: `${name}(${JSON.stringify(args).slice(0, 60)})`, outcome, escapes })
    }
    return out
  }, sentinel)

  expect(results.filter((r) => r.outcome === 'sem resposta'), 'todo canal responde').toEqual([])
  expect(isAlive(run.pid), 'o main segue vivo').toBe(true)
  expect(await run.app.evaluate(() => process.pid)).toBe(run.pid)
  expect(readdirSync(env.root).sort(), 'nada criado fora da pasta do projeto').toEqual(outside)
  expect(readFileSync(sentinel, 'utf8'), 'o arquivo fora do projeto ficou intacto').toBe('fora do projeto')
  expect(readFileSync(join(env.project, 'tracked.txt'), 'utf8'), 'arquivo do projeto intacto').toBe('original\n')
  // Recusa, nada encontrado ou SaveResult/CreateResult com ok:false; o "include" da busca é filtro, não caminho.
  for (const r of results.filter((r) => r.escapes)) expect(r.outcome, r.call).toMatch(/^erro|^ok (null|false|\[\]|\{"ok":false|\{"files":\[\])/)
  // null ou número no lugar de nome/caminho é recusado na entrada; convertido com String() virava "null" de verdade.
  const wrongType = [
    'renameEntry(["p1","descartavel.txt",null])',
    'renameEntry(["p1","descartavel.txt",5])',
    'createEntry(["p1","",null,"file"])',
    'createEntry(["p1",null,"x.txt","dir"])',
    'moveEntry(["p1","descartavel.txt",null])',
    'copyEntries(["p1",["descartavel.txt"],null])',
    'gitCreateBranch(["p1",null,false])',
    'gitCreateBranch(["p1",7,false])',
    'gitRenameBranch(["p1","main",null])',
    'gitSetRemote(["p1",null])',
    'gitStage(["p1",[null]])',
    'gitCommit(["p1",null,true])'
  ]
  for (const call of wrongType) {
    expect(results.find((r) => r.call === call)?.outcome, call).toMatch(/^erro .*Pedido inválido|^ok \{"ok":false,"message":"Pedido inválido/)
  }
  expect(readdirSync(env.project).filter((name) => /^(null|undefined|5|7)$/i.test(name)), 'nenhum arquivo com nome de null/número').toEqual([])
  expect(existsSync(join(env.project, 'descartavel.txt')), 'o arquivo do renomear continua no lugar').toBe(true)
  expect(git(env.project, env, 'branch', '--format=%(refname:short)'), 'nenhuma branch "null"').toBe('main')
  expect(git(env.project, env, 'remote'), 'nenhum remoto "null"').toBe('')
  expect(git(env.project, env, 'log', '--format=%s'), 'nenhum commit com a mensagem "null"').toBe('inicial')

  await terminalAlive(run, 'vivo-depois')
  await expect(page.getByText('Não foi possível mostrar esta aba')).toHaveCount(0)
  await expect(ui.tabBar(page)).toBeVisible()
})
