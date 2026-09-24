import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from './harness'
import {
  git,
  installShellSpy,
  newTab,
  pdfBytes,
  pngBytes,
  readClipboardText,
  readLog,
  readState,
  restoreClipboard,
  saveClipboard,
  seedRepo,
  shellCalls,
  starts,
  typeLine,
  ui,
  waitFor,
  type KoraRun
} from './kora'

const panelOf = (run: KoraRun) => run.page.locator('aside').last()
// O title é o caminho relativo com "\", que no seletor CSS precisa ser escapado.
const row = (run: KoraRun, rel: string) => panelOf(run).locator(`div[title="${rel.replaceAll('\\', '\\\\')}"]`)
const menuLabels = (run: KoraRun) => run.page.locator('body > div.fixed button').allTextContents()

test('R16 explorador: clique abre; menus de arquivo, pasta e área vazia; criar, copiar caminho e excluir com diálogo próprio', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'docs'))
  writeFileSync(join(env.project, 'docs', 'page.html'), '<h1>oi</h1>')
  writeFileSync(join(env.project, 'notas.txt'), 'notas')
  writeFileSync(join(env.project, 'apagar.txt'), 'apagar')
  const run = await kora.launch(env)
  const page = run.page
  await installShellSpy(run)

  await row(run, 'notas.txt').click()
  await expect(ui.barTab(page, 'notas.txt')).toBeVisible()

  await row(run, 'notas.txt').click({ button: 'right' })
  expect(await menuLabels(run)).toEqual([
    'Abrir',
    'Abrir no navegador padrão',
    'Abrir no programa padrão',
    'Mostrar no Explorer',
    'Renomear',
    'Novo arquivo',
    'Nova pasta',
    'Copiar caminho',
    'Copiar caminho relativo',
    'Excluir'
  ])
  await ui.menuItem(page, 'Abrir no programa padrão').click()
  await expect.poll(() => shellCalls(run)).toContainEqual(['openPath', join(env.project, 'notas.txt')])
  await row(run, 'notas.txt').click({ button: 'right' })
  await ui.menuItem(page, 'Mostrar no Explorer').click()
  await expect.poll(() => shellCalls(run)).toContainEqual(['showItemInFolder', join(env.project, 'notas.txt')])

  await row(run, 'docs').click()
  await row(run, 'docs\\page.html').click({ button: 'right' })
  await ui.menuItem(page, 'Abrir no navegador padrão').click()
  await expect
    .poll(async () => (await shellCalls(run)).find((c) => c[0] === 'spawn')?.some((a) => a.endsWith('/docs/page.html')))
    .toBe(true)

  await row(run, 'docs').click({ button: 'right' })
  expect(await menuLabels(run)).toEqual([
    'Novo arquivo',
    'Nova pasta',
    'Abrir no Explorer',
    'Renomear',
    'Copiar caminho',
    'Copiar caminho relativo',
    'Excluir'
  ])
  await ui.menuItem(page, 'Nova pasta').click()
  const dirInput = panelOf(run).getByPlaceholder('nome da pasta')
  await expect(dirInput).toBeVisible()
  await dirInput.fill('sub')
  await dirInput.press('Enter')
  await expect.poll(() => existsSync(join(env.project, 'docs', 'sub')) && statSync(join(env.project, 'docs', 'sub')).isDirectory()).toBe(true)
  await expect(row(run, 'docs\\sub')).toBeVisible()

  // Área vazia do explorador: criação na raiz.
  const empty = panelOf(run).locator('div.min-h-8')
  await empty.click({ button: 'right' })
  expect(await menuLabels(run)).toEqual(['Novo arquivo', 'Nova pasta', 'Abrir pasta do projeto no Explorer'])
  await ui.menuItem(page, 'Novo arquivo').click()
  const fileInput = panelOf(run).getByPlaceholder('nome do arquivo')
  await fileInput.fill('novo.txt')
  await fileInput.press('Enter')
  await expect.poll(() => existsSync(join(env.project, 'novo.txt'))).toBe(true)
  await expect(ui.barTab(page, 'novo.txt')).toBeVisible()

  const saved = await saveClipboard(run)
  try {
    await row(run, 'notas.txt').click({ button: 'right' })
    await ui.menuItem(page, 'Copiar caminho').click()
    await expect.poll(() => readClipboardText(run)).toBe(join(env.project, 'notas.txt'))
    await row(run, 'notas.txt').click({ button: 'right' })
    await ui.menuItem(page, 'Copiar caminho relativo').click()
    await expect.poll(() => readClipboardText(run)).toBe('notas.txt')
  } finally {
    await restoreClipboard(run, saved)
  }

  await row(run, 'apagar.txt').click({ button: 'right' })
  await ui.menuItem(page, 'Excluir').click()
  const dialog = page.locator('[role=dialog]')
  await expect(dialog).toContainText('Lixeira')
  await dialog.getByRole('button', { name: 'Mover para a Lixeira' }).click()
  await expect.poll(() => existsSync(join(env.project, 'apagar.txt'))).toBe(false)
  await expect(row(run, 'apagar.txt')).toHaveCount(0)
  expect(await run.nativeDialogs()).toEqual([])
})

test('R26 explorador acompanha o disco: arquivo movido, criado e pasta apagada por fora aparecem sem clicar em nada', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'docs', 'svg'), { recursive: true })
  writeFileSync(join(env.project, 'docs', 'svg', 'logo.svg'), '<svg/>')
  mkdirSync(join(env.project, 'velha'))
  writeFileSync(join(env.project, 'velha', 'x.txt'), 'x')
  const run = await kora.launch(env)

  await row(run, 'docs').click()
  await row(run, 'docs\\svg').click()
  await row(run, 'velha').click()
  await expect(row(run, 'docs\\svg\\logo.svg')).toBeVisible()
  await expect(row(run, 'velha\\x.txt')).toBeVisible()

  renameSync(join(env.project, 'docs', 'svg', 'logo.svg'), join(env.project, 'docs', 'logo.svg'))
  writeFileSync(join(env.project, 'novo.md'), '# novo')
  rmSync(join(env.project, 'velha'), { recursive: true })

  await expect(row(run, 'docs\\logo.svg')).toBeVisible({ timeout: 5000 })
  await expect(row(run, 'docs\\svg\\logo.svg')).toHaveCount(0)
  await expect(row(run, 'novo.md')).toBeVisible()
  await expect(row(run, 'velha')).toHaveCount(0)
  await expect(row(run, 'velha\\x.txt')).toHaveCount(0)
  await expect(panelOf(run).locator('p.text-destructive')).toHaveCount(0)
})

test('R33 explorador: arrastar move (aba aberta acompanha), duplo clique na pasta e F2 renomeiam; arquivo solto no terminal cola o caminho; F2 renomeia a aba', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'docs'))
  mkdirSync(join(env.project, 'arquivo-morto'))
  writeFileSync(join(env.project, 'notas.txt'), 'notas')
  writeFileSync(join(env.project, 'leia.md'), '# leia')
  const run = await kora.launch(env)
  const page = run.page

  await row(run, 'notas.txt').click()
  await expect(ui.barTab(page, 'notas.txt')).toBeVisible()
  await row(run, 'notas.txt').dragTo(row(run, 'docs'))
  await expect.poll(() => existsSync(join(env.project, 'docs', 'notas.txt'))).toBe(true)
  expect(existsSync(join(env.project, 'notas.txt'))).toBe(false)
  await expect(row(run, 'docs\\notas.txt')).toBeVisible()
  await expect(ui.barTab(page, 'notas.txt')).toHaveCount(1)
  await ui.barTab(page, 'notas.txt').click()
  await expect(page.locator('.monaco-editor').filter({ visible: true })).toContainText('notas')

  await row(run, 'arquivo-morto').dblclick()
  const renameInput = panelOf(run).locator('input').filter({ visible: true })
  await renameInput.fill('antigos')
  await renameInput.press('Enter')
  await expect.poll(() => existsSync(join(env.project, 'antigos'))).toBe(true)
  expect(existsSync(join(env.project, 'arquivo-morto'))).toBe(false)

  await row(run, 'leia.md').click()
  await row(run, 'leia.md').press('F2')
  await expect(renameInput).toBeVisible()
  await renameInput.fill('LEIAME.md')
  await renameInput.press('Enter')
  await expect.poll(() => existsSync(join(env.project, 'LEIAME.md'))).toBe(true)
  await expect(ui.barTab(page, 'LEIAME.md')).toBeVisible()

  await newTab(page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')
  await row(run, 'docs\\notas.txt').dragTo(ui.terminal(page))
  await ui.terminal(page).click()
  await page.keyboard.press('Enter')
  const line = await waitFor(() => readLog(env).find((e) => e.event === 'input'), 'claude falso recebeu a linha')
  expect(line.line?.trim()).toBe(join(env.project, 'docs', 'notas.txt'))

  await page.keyboard.press('F2')
  const tabInput = ui.tabBar(page).locator('input')
  await expect(tabInput).toBeVisible()
  await tabInput.fill('Revisão das notas')
  await tabInput.press('Enter')
  await waitFor(() => readState(env).tabs.find((t) => t.title === 'Revisão das notas'), 'aba renomeada pelo F2')
})

test('R35 caminho impresso no terminal: clique simples não abre; Ctrl+clique abre o arquivo, revela na árvore e vai até a linha', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'src'))
  writeFileSync(join(env.project, 'src', 'app.ts'), 'const a = 1' + '\n' + 'const b = 2' + '\n' + 'const c = 3' + '\n')
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Terminal')
  await typeLine(page, 'cls; Write-Host "Editei src\\app.ts:3 agora"')
  await expect(row(run, 'src\\app.ts')).toHaveCount(0)

  const box = (await ui.terminal(page).boundingBox())!
  const cell = await page.evaluate(() => {
    const t = document.querySelector('.xterm-helper-textarea') as HTMLElement
    return { w: t.offsetWidth, h: t.offsetHeight }
  })
  const x = box.x + cell.w * 10 + cell.w / 2
  const y = box.y + cell.h / 2
  // O xterm guarda a resposta do link por linha enquanto o mouse fica nela: sair da linha força consultar de novo.
  const hover = async (): Promise<void> => {
    await page.mouse.move(x, y + cell.h * 10)
    await page.mouse.move(x - cell.w, y)
    await page.mouse.move(x, y)
    await page.waitForTimeout(300)
  }
  // Clique simples, mesmo com o link já detectado (várias passadas do mouse), não abre nada.
  for (let i = 0; i < 3; i++) {
    await hover()
    await page.mouse.click(x, y)
  }
  await page.waitForTimeout(500)
  await expect(ui.barTab(page, 'app.ts')).toHaveCount(0)

  await expect
    .poll(async () => {
      await hover()
      await page.keyboard.down('Control')
      await page.mouse.click(x, y)
      await page.keyboard.up('Control')
      return ui.barTab(page, 'app.ts').count()
    }, { timeout: 15_000, intervals: [1000] })
    .toBe(1)
  await expect(row(run, 'src\\app.ts')).toBeVisible()
  const editor = page.locator('.monaco-editor').filter({ visible: true })
  await expect(editor.locator('.active-line-number')).toHaveText('3')
})

test('R17 explorador com git: modificado com cor e M, não rastreado com U, pasta ignorada opaca inclusive o ícone', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  writeFileSync(join(env.project, 'tracked.txt'), 'alterado\n')
  writeFileSync(join(env.project, 'novo.txt'), 'novo\n')
  const run = await kora.launch(env)

  const modified = row(run, 'tracked.txt')
  await expect(modified.locator('span.font-semibold')).toHaveText('M')
  const untracked = row(run, 'novo.txt')
  await expect(untracked.locator('span.font-semibold')).toHaveText('U')
  const colors = await Promise.all(
    [modified, untracked, row(run, 'README.md')].map((r) => r.locator('span.truncate').evaluate((e) => getComputedStyle(e).color))
  )
  expect(['rgb(137, 85, 3)', 'rgb(226, 192, 141)']).toContain(colors[0])
  expect(['rgb(88, 124, 12)', 'rgb(115, 201, 145)']).toContain(colors[1])
  expect(colors[2]).not.toBe(colors[0])

  const ignored = row(run, 'ignored-dir')
  await expect.poll(() => ignored.locator('span.truncate').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.45')
  expect(await ignored.locator('svg').nth(1).evaluate((e) => getComputedStyle(e).opacity)).toBe('0.4')
  expect(await row(run, 'src').locator('svg').nth(1).evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
})

test('R18 editor: .ts abre no Monaco, Ctrl+S grava; mudança no disco gera aviso de conflito e não sobrescreve', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const file = join(env.project, 'src', 'app.ts')
  const run = await kora.launch(env)
  const page = run.page

  await row(run, 'src').click()
  await row(run, 'src\\app.ts').click()
  const editor = page.locator('.monaco-editor').filter({ visible: true })
  await expect(editor).toBeVisible()
  await expect(editor.locator('.view-lines')).toContainText('export const valor = 1')
  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('// editado no kora')
  await expect(page.getByText('Não salvo').filter({ visible: true })).toBeVisible()
  await page.keyboard.press('Control+S')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('// editado no kora')
  await expect(page.getByText('Não salvo').filter({ visible: true })).toHaveCount(0)

  writeFileSync(file, 'externo\n')
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' mais')
  await page.keyboard.press('Control+S')
  await expect(page.getByText('O arquivo mudou no disco').filter({ visible: true })).toBeVisible()
  expect(readFileSync(file, 'utf8')).toBe('externo\n')
})

test('R19 Markdown abre renderizado com Visualizar | Editar; Editar abre o Monaco', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const run = await kora.launch(env)
  const page = run.page
  await row(run, 'README.md').click()
  const article = page.locator('article.markdown').filter({ visible: true })
  await expect(article.locator('h1')).toHaveText('Título do README')
  await expect(article.locator('strong')).toHaveText('forte')
  await expect(ui.visibleButton(page, 'Visualizar')).toBeVisible()
  await expect(ui.visibleButton(page, 'Editar')).toBeVisible()
  await ui.visibleButton(page, 'Editar').click()
  const editor = page.locator('.monaco-editor').filter({ visible: true })
  await expect(editor).toBeVisible()
  await expect(editor.locator('.view-lines')).toContainText('# Título do README')
  await ui.visibleButton(page, 'Visualizar').click()
  await expect(page.locator('article.markdown').filter({ visible: true }).locator('h1')).toBeVisible()
})

test('R20 PDF e imagem abrem em aba', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'doc.pdf'), pdfBytes())
  writeFileSync(join(env.project, 'foto.png'), pngBytes(6, 4))
  const run = await kora.launch(env)
  const page = run.page

  await row(run, 'doc.pdf').click()
  await expect(ui.barTab(page, 'doc.pdf')).toBeVisible()
  const frame = page.locator('iframe').filter({ visible: true })
  await expect(frame).toHaveAttribute('src', /^kora-file:\/\/project\/p1\/doc\.pdf/)
  const src = (await frame.getAttribute('src'))!
  // A CSP do renderer não deixa o fetch da página ler kora-file:; o main pede pelo mesmo protocolo.
  const pdf = await run.app.evaluate(async ({ net }, url) => {
    const res = await net.fetch(url)
    return { status: res.status, type: res.headers.get('content-type'), head: (await res.text()).slice(0, 8) }
  }, src)
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('kora-file://project/p1/doc.pdf'))).toBe(true)
  expect(pdf).toEqual({ status: 200, type: expect.stringContaining('pdf'), head: '%PDF-1.4' })

  await row(run, 'foto.png').click()
  await expect(ui.barTab(page, 'foto.png')).toBeVisible()
  const img = page.locator('img').filter({ visible: true })
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(6)
  await expect(page.getByText('6 × 4').filter({ visible: true })).toBeVisible()
})

test('R32 Git em pasta sem repositório: Inicializar cria o repo; vincular ao GitHub recusa URL com token e grava a válida', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const panel = panelOf(run)
  await panel.getByRole('button', { name: 'Git' }).click()
  await panel.getByRole('button', { name: 'Inicializar repositório' }).click()
  await expect.poll(() => existsSync(join(env.project, '.git'))).toBe(true)

  await panel.getByRole('button', { name: 'Vincular ao GitHub' }).click()
  const url = panel.getByPlaceholder('https://github.com/dono/repositorio')
  await url.fill('https://eu:ghp_segredo@github.com/dono/repo')
  await url.press('Enter')
  await expect(panel.getByText(/não pode conter usuário, senha ou token/)).toBeVisible()
  expect(() => git(env.project, env, 'remote', 'get-url', 'origin')).toThrow()

  await panel.getByRole('button', { name: 'Vincular ao GitHub' }).click()
  await url.fill('  https://github.com/dono/repo/  ')
  await url.press('Enter')
  await expect(panel.getByText('origin · dono/repo')).toBeVisible()
  expect(git(env.project, env, 'remote', 'get-url', 'origin').trim()).toBe('https://github.com/dono/repo.git')
})

test('R21 Git: branch atual, locais, remotas e worktrees; criar branch e trocar funcionam', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const remote = join(env.root, 'remoto.git')
  git(env.root, env, 'init', '-q', '--bare', remote)
  git(env.project, env, 'remote', 'add', 'origin', remote)
  git(env.project, env, 'push', '-q', '-u', 'origin', 'main')
  git(env.project, env, 'branch', 'feature-x')
  git(env.project, env, 'push', '-q', 'origin', 'feature-x')
  git(env.project, env, 'worktree', 'add', '-q', join(env.root, 'wt-teste'), '-b', 'wt-branch')

  const run = await kora.launch(env)
  const page = run.page
  const panel = panelOf(run)
  await panel.getByRole('button', { name: 'Git' }).click()

  const head = panel.locator('div.h-8 button').first()
  await expect(head).toContainText('main')
  const branchRows = panel.locator('div[title*="Clique para trocar"], div[title*="Branch atual"]')
  await expect(branchRows).toHaveCount(3)
  const names = await branchRows.locator('span.flex-1').allTextContents()
  expect(names.sort()).toEqual(['feature-x', 'main', 'wt-branch'])

  await expect(panel.getByText('Remotas')).toBeVisible()
  await panel.locator('span.flex-1', { hasText: /^origin$/ }).click()
  const remoteRows = panel.locator('div[title*="rastreando origin/"]')
  await expect(remoteRows.locator('span.flex-1')).toHaveText(['feature-x', 'main'])

  await expect(panel.getByText('Worktrees')).toBeVisible()
  await expect(panel.locator('div[title*="wt-teste"]')).toContainText('wt-branch')
  await expect(panel.locator('div[title*="worktree atual"]')).toContainText('proj-teste')

  await panel.getByRole('button', { name: 'Nova branch' }).click()
  const input = panel.getByPlaceholder('nome-da-branch')
  await input.fill('nova-branch')
  await input.press('Enter')
  await expect.poll(() => git(env.project, env, 'branch', '--show-current')).toBe('nova-branch')
  await expect(head).toContainText('nova-branch')

  await panel.locator('div[title*="Clique para trocar"]').filter({ hasText: 'feature-x' }).click()
  await expect.poll(() => git(env.project, env, 'branch', '--show-current')).toBe('feature-x')
  await expect(head).toContainText('feature-x')
  expect(await run.nativeDialogs()).toEqual([])
  void page
})

test('R42 editor: botão Salvar no topo grava o arquivo; sem alteração fica desabilitado; nada é salvo sozinho', async ({ kora }) => {
  const env = kora.env()
  const file = join(env.project, 'config.json')
  writeFileSync(file, '{\n  "a": 1\n}\n')
  const run = await kora.launch(env)
  const page = run.page

  await row(run, 'config.json').click()
  const editor = page.locator('.monaco-editor').filter({ visible: true })
  await expect(editor.locator('.view-lines')).toContainText('"a": 1')
  const saveButton = ui.visibleButton(page, 'Salvar')
  await expect(saveButton).toBeDisabled()

  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('// x')
  await expect(page.getByText('Não salvo').filter({ visible: true })).toBeVisible()
  await expect(saveButton).toBeEnabled()
  // Janela maior que qualquer autosave razoável: o disco não pode mudar sem Ctrl+S ou o botão.
  await page.waitForTimeout(2500)
  expect(readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}\n')

  await saveButton.click()
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('// x')
  await expect(page.getByText('Não salvo').filter({ visible: true })).toHaveCount(0)
  await expect(saveButton).toBeDisabled()
})

test('R43 texto dos arquivos: tamanho próprio no painel Aa e no Ctrl + roda sobre o arquivo, sem mexer no terminal nem na interface', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  writeFileSync(join(env.project, 'dados.json'), '{ "b": 2 }\n')
  const run = await kora.launch(env)
  const page = run.page
  const zoomFactor = () => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())
  const editorFont = () =>
    page.evaluate(() => {
      const lines = [...document.querySelectorAll<HTMLElement>('.monaco-editor .view-lines')].find((e) => e.offsetParent !== null)
      return lines ? getComputedStyle(lines).fontSize : ''
    })
  const markdownFont = () => page.locator('article.markdown').filter({ visible: true }).evaluate((e) => getComputedStyle(e).fontSize)

  await row(run, 'dados.json').click()
  await expect.poll(editorFont).toBe('13px')

  await page.getByTitle('Tamanho da interface, do terminal e dos arquivos').click()
  const panel = page.getByRole('dialog', { name: 'Tamanhos' })
  await panel.getByTitle('Aumentar texto dos arquivos').click()
  await panel.getByTitle('Aumentar texto dos arquivos').click()
  await expect.poll(editorFont).toBe('15px')
  await page.keyboard.press('Escape')
  expect(await zoomFactor()).toBeCloseTo(1)
  await waitFor(() => readState(env).settings?.fileFontSize === 15 && readState(env).settings?.terminalFontSize === 14, 'tamanho dos arquivos salvo')

  await row(run, 'README.md').click()
  await expect.poll(markdownFont).toBe('15px')
  const article = page.locator('article.markdown').filter({ visible: true })
  const box = (await article.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 10)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect.poll(markdownFont).toBe('16px')
  expect(await zoomFactor()).toBeCloseTo(1)
  await waitFor(() => readState(env).settings?.fileFontSize === 16, 'Ctrl + roda sobre o arquivo salvo')
})

test('R46 explorador sem trocar de aba: .gitignore editado por fora deixa o item opaco na hora; cor do git chega antes do polling', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  writeFileSync(join(env.project, 'segredo.env'), 'x=1\n')
  const run = await kora.launch(env)
  const opacity = (rel: string) => row(run, rel).locator('span.truncate').evaluate((e) => getComputedStyle(e).opacity)

  await expect(row(run, 'segredo.env')).toBeVisible()
  await expect(row(run, 'segredo.env').locator('span.font-semibold')).toHaveText('U')
  await expect.poll(() => opacity('segredo.env')).toBe('1')

  appendFileSync(join(env.project, '.gitignore'), 'segredo.env\n')
  await expect.poll(() => opacity('segredo.env'), { timeout: 4000 }).toBe('0.45')

  // O polling do status é de 5 s: três viradas seguidas, cada uma em até 1,5 s, só passam pelo aviso do watcher.
  const tracked = row(run, 'tracked.txt').locator('span.font-semibold')
  await expect(tracked).toHaveCount(0)
  for (const [content, letter] of [['mudou\n', 1], ['original\n', 0], ['de novo\n', 1]] as const) {
    writeFileSync(join(env.project, 'tracked.txt'), content)
    await expect(tracked).toHaveCount(letter, { timeout: 1500 })
  }
})

test('R47 arquivos soltos do Explorer do Windows no terminal viram caminhos colados (imagem e qualquer outro, com aspas se tiver espaço)', async ({ kora }) => {
  const env = kora.env()
  const outside = join(env.root, 'fora do projeto')
  mkdirSync(outside)
  const image = join(outside, 'print da tela.png')
  const doc = join(env.root, 'contrato.pdf')
  writeFileSync(image, pngBytes())
  writeFileSync(doc, pdfBytes())
  const run = await kora.launch(env)
  const page = run.page

  await newTab(page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')
  // Arrasto do sistema não é simulável pelo Playwright; um <input type=file> entrega File com caminho real no disco,
  // o mesmo tipo de objeto que o Explorer do Windows entrega no drop.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = 'arquivos-do-sistema'
    input.style.display = 'none'
    document.body.append(input)
  })
  await page.locator('#arquivos-do-sistema').setInputFiles([image, doc])
  const dropTarget = ui.terminal(page)
  const accepted = await dropTarget.evaluate((el) => {
    const input = document.getElementById('arquivos-do-sistema') as HTMLInputElement
    const data = new DataTransfer()
    for (const file of input.files!) data.items.add(file)
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
    el.dispatchEvent(over)
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    return over.defaultPrevented
  })
  expect(accepted, 'o terminal aceita o arrasto de arquivos do sistema').toBe(true)
  await ui.terminal(page).click()
  await page.keyboard.press('Enter')
  const line = await waitFor(() => readLog(env).find((e) => e.event === 'input'), 'claude falso recebeu a linha')
  expect(line.line?.trim()).toBe(`"${image}" ${doc}`)
})

test('R54 arrastar arquivo da árvore leva o link file:// que o navegador abre; pasta não leva link', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'relatórios'))
  writeFileSync(join(env.project, 'relatórios', 'mês #1.html'), '<h1>oi</h1>')
  const run = await kora.launch(env)
  await row(run, 'relatórios').click()
  const dragged = (rel: string) =>
    row(run, rel).evaluate((el) => {
      const data = new DataTransfer()
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
      return { uri: data.getData('text/uri-list'), text: data.getData('text/plain') }
    })
  const file = join(env.project, 'relatórios', 'mês #1.html')
  expect(await dragged('relatórios\\mês #1.html')).toEqual({ uri: pathToFileURL(file).href, text: file })
  expect((await dragged('relatórios')).uri).toBe('')
})

test('R55 arquivos soltos do Explorer do Windows numa pasta da árvore (ou na área vazia) são copiados para ela', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'docs'))
  writeFileSync(join(env.project, 'docs', 'nota.txt'), 'já estava\n')
  const outside = join(env.root, 'Downloads')
  mkdirSync(outside)
  writeFileSync(join(outside, 'nota.txt'), 'de fora\n')
  writeFileSync(join(outside, 'print.png'), pngBytes())
  const run = await kora.launch(env)
  const page = run.page
  await expect(row(run, 'docs')).toBeVisible()

  // Arrasto do sistema não é simulável pelo Playwright; um <input type=file> entrega File com caminho real no disco,
  // o mesmo tipo de objeto que o Explorer do Windows entrega no drop.
  const dropFiles = async (target: import('@playwright/test').Locator, paths: string[]): Promise<boolean> => {
    await page.evaluate(() => {
      document.getElementById('arquivos-do-sistema')?.remove()
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.id = 'arquivos-do-sistema'
      input.style.display = 'none'
      document.body.append(input)
    })
    await page.locator('#arquivos-do-sistema').setInputFiles(paths)
    return target.evaluate((el) => {
      const input = document.getElementById('arquivos-do-sistema') as HTMLInputElement
      const data = new DataTransfer()
      for (const file of input.files!) data.items.add(file)
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
      el.dispatchEvent(over)
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
      return over.defaultPrevented
    })
  }

  expect(await dropFiles(row(run, 'docs'), [join(outside, 'nota.txt'), join(outside, 'print.png')]), 'a pasta aceita o arrasto').toBe(true)
  await expect(row(run, 'docs\\nota (2).txt')).toBeVisible()
  await expect(row(run, 'docs\\print.png')).toBeVisible()
  expect(readFileSync(join(env.project, 'docs', 'nota (2).txt'), 'utf8')).toBe('de fora\n')
  expect(readFileSync(join(env.project, 'docs', 'nota.txt'), 'utf8'), 'o que já estava não é sobrescrito').toBe('já estava\n')
  expect(existsSync(join(outside, 'print.png')), 'o original fica onde estava').toBe(true)

  await dropFiles(panelOf(run).locator('div.min-h-8.flex-1'), [join(outside, 'print.png')])
  await expect(row(run, 'print.png')).toBeVisible()
  expect(existsSync(join(env.project, 'print.png')), 'solto na área vazia vai para a raiz').toBe(true)
})
