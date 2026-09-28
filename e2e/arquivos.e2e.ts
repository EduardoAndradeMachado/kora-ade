import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  tip,
  typeLine,
  ui,
  waitFor,
  type KoraRun
} from './kora'

const panelOf = (run: KoraRun) => run.page.locator('aside').last()
// A dica (data-tip) é o caminho relativo com "\", que no seletor CSS precisa ser escapado.
const row = (run: KoraRun, rel: string) => panelOf(run).locator(`div[data-tip="${rel.replaceAll('\\', '\\\\')}"]`)
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

const changedOutside = (page: KoraRun['page']) => page.getByText('O arquivo mudou no disco').filter({ visible: true })
const unsaved = (page: KoraRun['page']) => page.getByText('Não salvo').filter({ visible: true })

async function openAppTs(run: KoraRun) {
  await row(run, 'src').click()
  await row(run, 'src\\app.ts').click()
  const lines = run.page.locator('.monaco-editor').filter({ visible: true }).locator('.view-lines')
  await expect(lines).toContainText('export const valor = 1')
  return lines
}

test('R18 editor: .ts abre no Monaco, Ctrl+S grava; seguir digitando logo depois de salvar não vira aviso de mudança por fora', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const file = join(env.project, 'src', 'app.ts')
  const run = await kora.launch(env)
  const page = run.page

  const lines = await openAppTs(run)
  await lines.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('// editado no kora')
  await expect(unsaved(page)).toBeVisible()
  await page.keyboard.press('Control+S')
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('// editado no kora')
  await expect(unsaved(page)).toHaveCount(0)

  // O watcher avisa a gravação do próprio Kora: com o texto já diferente do disco, isso não pode parecer conflito.
  await page.keyboard.type(' mais')
  await expect(unsaved(page)).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(changedOutside(page)).toHaveCount(0)
  await expect(lines).toContainText('// editado no kora mais')
})

test('R73 arquivo aberto sem alteração e mudado por fora (gravação direta ou renomear por cima) aparece sozinho, sem aviso; Ctrl+Z volta', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const file = join(env.project, 'src', 'app.ts')
  const run = await kora.launch(env)
  const page = run.page

  const lines = await openAppTs(run)
  writeFileSync(file, 'export const valor = 2 // do agente\n')
  await expect(lines).toContainText('export const valor = 2 // do agente')

  const tmp = join(env.project, 'src', 'app.ts.tmp')
  writeFileSync(tmp, 'export const valor = 3 // renomeado por cima\n')
  renameSync(tmp, file)
  await expect(lines).toContainText('export const valor = 3 // renomeado por cima')
  await expect(changedOutside(page)).toHaveCount(0)
  await expect(unsaved(page)).toHaveCount(0)

  await lines.click()
  await page.keyboard.press('Control+Z')
  await expect(lines).toContainText('export const valor = 2 // do agente')
  await expect(unsaved(page)).toBeVisible()
})

test('R74 com edição pendente, mudança por fora avisa na hora sem esperar o Ctrl+S; Ctrl+S não sobrescreve; Sobrescrever e Recarregar resolvem', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const file = join(env.project, 'src', 'app.ts')
  const run = await kora.launch(env)
  const page = run.page

  const lines = await openAppTs(run)
  await lines.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('// meu')
  await expect(unsaved(page)).toBeVisible()

  writeFileSync(file, 'externo\n')
  await expect(changedOutside(page)).toBeVisible()
  await expect(lines).toContainText('// meu')

  await lines.click()
  await page.keyboard.press('Control+S')
  await page.waitForTimeout(500)
  expect(readFileSync(file, 'utf8')).toBe('externo\n')
  await expect(changedOutside(page)).toBeVisible()

  await ui.visibleButton(page, 'Sobrescrever').click()
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('// meu')
  await expect(changedOutside(page)).toHaveCount(0)
  await expect(unsaved(page)).toHaveCount(0)

  await lines.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' de novo')
  writeFileSync(file, 'do agente outra vez\n')
  await expect(changedOutside(page)).toBeVisible()
  await ui.visibleButton(page, 'Recarregar do disco').click()
  await expect(lines).toContainText('do agente outra vez')
  await expect(changedOutside(page)).toHaveCount(0)
  await expect(unsaved(page)).toHaveCount(0)
})

test('R75 Visualizar do Markdown acompanha o arquivo alterado por fora', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const run = await kora.launch(env)
  await row(run, 'README.md').click()
  const article = run.page.locator('article.markdown').filter({ visible: true })
  await expect(article.locator('h1')).toHaveText('Título do README')
  writeFileSync(join(env.project, 'README.md'), '# Título novo do agente\n')
  await expect(article.locator('h1')).toHaveText('Título novo do agente')
})

test('R84 botão direito no Markdown em visualização copia o trecho selecionado e seleciona só o documento', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  const run = await kora.launch(env)
  const page = run.page
  await row(run, 'README.md').click()
  const article = page.locator('article.markdown').filter({ visible: true })
  const title = article.locator('h1')
  await expect(title).toHaveText('Título do README')

  const saved = await saveClipboard(run)
  try {
    await title.selectText()
    await title.click({ button: 'right' })
    await ui.menuItem(page, 'Copiar').click()
    await expect.poll(() => readClipboardText(run)).toBe('Título do README')
  } finally {
    await restoreClipboard(run, saved)
  }

  // Sem seleção e no espaço vazio abaixo do texto, fora da coluna do artigo: o menu aparece do mesmo jeito.
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  const viewer = article.locator('..')
  const box = (await viewer.boundingBox())!
  await viewer.click({ button: 'right', position: { x: 8, y: box.height - 8 } })
  await expect(ui.menuItem(page, 'Copiar')).toHaveCount(0)
  await ui.menuItem(page, 'Selecionar tudo').click()
  const selection = await viewer.evaluate((el) => {
    const sel = window.getSelection()!
    return { text: sel.toString(), inside: el.contains(sel.anchorNode) && el.contains(sel.focusNode) }
  })
  expect(selection.inside).toBe(true)
  expect(selection.text).toContain('Título do README')
  expect(selection.text).toContain('Parágrafo forte.')
})

test('R76 quebra de linha no editor: botão e Alt+Z ligam e desligam, a escolha fica salva e vale para o próximo arquivo aberto', async ({ kora }) => {
  const env = kora.env()
  const long = 'palavra '.repeat(250).trim()
  writeFileSync(join(env.project, 'longo.txt'), long)
  writeFileSync(join(env.project, 'outro.txt'), long)
  const run = await kora.launch(env)
  const page = run.page
  const visibleLines = () => page.locator('.monaco-editor').filter({ visible: true }).locator('.view-lines .view-line')
  const wrapButton = page.locator('button[aria-pressed]').filter({ visible: true })

  await row(run, 'longo.txt').click()
  await expect(visibleLines()).toHaveCount(1)
  await expect(wrapButton).toHaveAttribute('aria-pressed', 'false')

  await wrapButton.click()
  await expect.poll(() => visibleLines().count()).toBeGreaterThan(3)
  await expect(wrapButton).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => readState(env).settings?.fileWordWrap).toBe(true)

  await visibleLines().first().click()
  await page.keyboard.press('Alt+Z')
  await expect(visibleLines()).toHaveCount(1)
  await expect.poll(() => readState(env).settings?.fileWordWrap).toBe(false)
  await page.keyboard.press('Alt+Z')
  await expect.poll(() => visibleLines().count()).toBeGreaterThan(3)

  await row(run, 'outro.txt').click()
  await expect(ui.barTab(page, 'outro.txt')).toBeVisible()
  await expect.poll(() => visibleLines().count()).toBeGreaterThan(3)
  expect(readFileSync(join(env.project, 'longo.txt'), 'utf8')).toBe(long)
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
  // A atualização automática (aqui pelo foco da janela) não pode apagar o erro da ação: o arquivo novo
  // aparecendo na lista prova que ela rodou.
  writeFileSync(join(env.project, 'depois-do-erro.txt'), 'x\n')
  await run.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(panel.locator('[data-git-file="depois-do-erro.txt"]')).toBeVisible()
  await expect(panel.getByText(/não pode conter usuário, senha ou token/)).toBeVisible()

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
  const branchRows = panel.locator('div[data-tip*="Clique para trocar"], div[data-tip*="Branch atual"]')
  await expect(branchRows).toHaveCount(3)
  const names = await branchRows.locator('span.flex-1').allTextContents()
  expect(names.sort()).toEqual(['feature-x', 'main', 'wt-branch'])

  await expect(panel.getByText('Remotas')).toBeVisible()
  await panel.locator('span.flex-1', { hasText: /^origin$/ }).click()
  const remoteRows = panel.locator('div[data-tip*="rastreando origin/"]')
  await expect(remoteRows.locator('span.flex-1')).toHaveText(['feature-x', 'main'])

  await expect(panel.getByText('Worktrees')).toBeVisible()
  await expect(panel.locator('div[data-tip*="wt-teste"]')).toContainText('wt-branch')
  await expect(panel.locator('div[data-tip*="worktree atual"]')).toContainText('proj-teste')

  await panel.getByRole('button', { name: 'Nova branch' }).click()
  const input = panel.getByPlaceholder('nome-da-branch')
  await input.fill('nova-branch')
  await input.press('Enter')
  await expect.poll(() => git(env.project, env, 'branch', '--show-current')).toBe('nova-branch')
  await expect(head).toContainText('nova-branch')

  await panel.locator('div[data-tip*="Clique para trocar"]').filter({ hasText: 'feature-x' }).click()
  await expect.poll(() => git(env.project, env, 'branch', '--show-current')).toBe('feature-x')
  await expect(head).toContainText('feature-x')
  expect(await run.nativeDialogs()).toEqual([])
  void page
})

test('R81 Git como no VS Code: diff ao clicar, descartar, fila e tirar da fila, commit (Ctrl+Enter e sem nada na fila), push, buscar e pull', async ({ kora }) => {
  const env = kora.env()
  seedRepo(env)
  // O app roda o git com HOME = env.home: é daí que sai o autor do commit feito pela interface.
  writeFileSync(join(env.home, '.gitconfig'), '[user]\n\tname = Kora E2E\n\temail = e2e@kora.invalid\n[commit]\n\tgpgsign = false\n')
  const remote = join(env.root, 'remoto.git')
  git(env.root, env, 'init', '-q', '--bare', '-b', 'main', remote)
  git(env.project, env, 'branch', '-M', 'main')
  git(env.project, env, 'remote', 'add', 'origin', remote)
  git(env.project, env, 'push', '-q', '-u', 'origin', 'main')
  writeFileSync(join(env.project, 'tracked.txt'), 'alterado\n')
  writeFileSync(join(env.project, 'src', 'app.ts'), 'export const valor = 2\n')
  writeFileSync(join(env.project, 'novo.txt'), 'não rastreado\n')

  const run = await kora.launch(env)
  const page = run.page
  const panel = panelOf(run)
  await panel.getByRole('button', { name: 'Git' }).click()

  const fileRow = (group: string, rel: string) =>
    panel.locator(`[data-git-group="files:${group}"] [data-git-file="${rel.replaceAll('\\', '\\\\')}"]`)
  const rowAction = async (group: string, rel: string, label: string): Promise<void> => {
    const r = fileRow(group, rel)
    await r.hover()
    await r.getByRole('button', { name: label }).click()
  }
  const cached = (): string => git(env.project, env, 'diff', '--cached', '--name-only')
  const diffSide = (side: 'original' | 'modified') =>
    page.locator('[data-diff-view]').filter({ visible: true }).locator(`.monaco-diff-editor .editor.${side} .view-lines:not(.line-delete)`)

  // Clique na alteração abre o diff fila ↔ disco, e o diff acompanha o arquivo mudando no disco.
  await fileRow('changes', 'tracked.txt').click()
  await expect(ui.barTab(page, 'tracked.txt (alterações)')).toBeVisible()
  await expect(diffSide('original')).toContainText('original')
  await expect(diffSide('modified')).toContainText('alterado')
  writeFileSync(join(env.project, 'tracked.txt'), 'alterado de novo\n')
  await expect(diffSide('modified')).toContainText('alterado de novo')

  // Descartar pede confirmação no diálogo do app e volta o arquivo à versão da fila.
  await rowAction('changes', join('src', 'app.ts'), 'Descartar alterações')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Descartar as alterações em "app.ts"?')
  await dialog.getByRole('button', { name: 'Descartar' }).click()
  // O git do app usa a config de sistema do Git for Windows (autocrlf): o arquivo volta com CRLF.
  await expect.poll(() => readFileSync(join(env.project, 'src', 'app.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const valor = 1\n')
  await expect(fileRow('changes', join('src', 'app.ts'))).toHaveCount(0)

  // Fila: colocar, abrir o diff HEAD ↔ fila, tirar e colocar de novo.
  await rowAction('changes', 'tracked.txt', 'Colocar na fila')
  await expect.poll(cached).toBe('tracked.txt')
  await fileRow('staged', 'tracked.txt').click()
  await expect(ui.barTab(page, 'tracked.txt (na fila)')).toBeVisible()
  await expect(diffSide('original')).toContainText('original')
  await expect(diffSide('modified')).toContainText('alterado de novo')
  await rowAction('staged', 'tracked.txt', 'Tirar da fila')
  await expect.poll(cached).toBe('')
  await expect(fileRow('changes', 'tracked.txt')).toBeVisible()
  await rowAction('changes', 'tracked.txt', 'Colocar na fila')
  await expect.poll(cached).toBe('tracked.txt')

  // Commit com Ctrl+Enter leva só o que está na fila; a mensagem de várias linhas chega intacta.
  const message = panel.getByRole('textbox', { name: 'Mensagem do commit' })
  await message.fill('feat: commit pelo Kora\n\ncorpo com acentuação')
  await message.press('Control+Enter')
  await expect.poll(() => git(env.project, env, 'log', '-1', '--format=%B')).toBe('feat: commit pelo Kora\n\ncorpo com acentuação')
  expect(git(env.project, env, 'show', '--name-only', '--format=', 'HEAD')).toBe('tracked.txt')
  await expect(message).toHaveValue('')
  await expect(fileRow('untracked', 'novo.txt')).toBeVisible()

  // Push mostra quantos commits vão e envia.
  const push = panel.getByRole('button', { name: /^Push/ })
  await expect(push).toHaveText('Push1')
  await push.click()
  await expect.poll(() => git(remote, env, 'log', '-1', '--format=%s', 'main')).toBe('feat: commit pelo Kora')
  await expect(push).toHaveText('Push')

  // Commit de outro clone: Buscar mostra o "atrás" e Pull traz o arquivo.
  const other = join(env.root, 'outro')
  git(env.root, env, 'clone', '-q', remote, other)
  writeFileSync(join(other, 'remoto.txt'), 'veio do remoto\n')
  git(other, env, 'add', '-A')
  git(other, env, 'commit', '-q', '-m', 'commit remoto')
  git(other, env, 'push', '-q', 'origin', 'main')
  const pull = panel.getByRole('button', { name: /^Pull/ })
  // Dica na identidade do app, não o title nativo do Windows.
  const fetch = panel.getByRole('button', { name: 'Buscar' })
  await expect(fetch).not.toHaveAttribute('title')
  await fetch.hover()
  await expect(page.getByRole('tooltip')).toContainText('Atualiza o que o remoto tem, sem mexer nos seus arquivos.')
  await fetch.click()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(pull).toHaveText('Pull1')
  await pull.click()
  await expect.poll(() => existsSync(join(env.project, 'remoto.txt'))).toBe(true)
  await expect(pull).toHaveText('Pull')

  // Sem nada na fila, o commit pergunta e coloca tudo (inclusive o não rastreado).
  writeFileSync(join(env.project, 'tracked.txt'), 'terceira versão\n')
  await message.fill('chore: tudo de uma vez')
  await panel.getByRole('button', { name: 'Commitar' }).click()
  await expect(dialog).toContainText('Colocar todas as alterações do projeto na fila e commitar?')
  await dialog.getByRole('button', { name: 'Colocar tudo e commitar' }).click()
  await expect.poll(() => git(env.project, env, 'log', '-1', '--format=%s')).toBe('chore: tudo de uma vez')
  expect(git(env.project, env, 'show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).sort()).toEqual(['novo.txt', 'tracked.txt'])
  await expect(panel.getByText('Nenhuma alteração.')).toBeVisible()
  expect(await run.nativeDialogs()).toEqual([])
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

  await page.locator(tip('Tamanho da interface, do terminal e dos arquivos')).click()
  const panel = page.getByRole('dialog', { name: 'Tamanhos' })
  await panel.locator(tip('Aumentar texto dos arquivos')).click()
  await panel.locator(tip('Aumentar texto dos arquivos')).click()
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

test('R65 "Copiar caminho" de imagem e Ctrl+V no chat chega como texto digitado; arrastar a imagem continua chegando como colar', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'tela.png'), pngBytes())
  const image = join(env.project, 'tela.png')
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')
  const inputs = () => readLog(env).filter((e) => e.event === 'input')
  const sendLine = async (): Promise<{ line?: string; pasted?: boolean }> => {
    const before = inputs().length
    await ui.terminal(page).click()
    await page.keyboard.press('Enter')
    return waitFor(() => inputs()[before], 'claude falso recebeu a linha')
  }

  // Arrastar: o Claude real anexa a imagem porque recebe um colar com o caminho.
  await row(run, 'tela.png').dragTo(ui.terminal(page))
  const dragged = await sendLine()
  expect(dragged.line?.trim()).toBe(image)
  expect(dragged.pasted, 'arrastar chega como colar').toBe(true)

  const saved = await saveClipboard(run)
  try {
    await row(run, 'tela.png').click({ button: 'right' })
    await page.locator('body > div.fixed button').filter({ hasText: /^Copiar caminho$/ }).click()
    await ui.terminal(page).click()
    await page.keyboard.press('Control+V')
    expect(await sendLine(), '"Copiar caminho" do Kora chega digitado: o Claude não converte em imagem').toMatchObject({ line: image, pasted: false })

    // Caminho que veio de fora do Kora segue o comportamento normal do terminal.
    const outside = join(env.root, 'outra.png')
    await run.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), outside)
    await ui.terminal(page).click()
    await page.keyboard.press('Control+V')
    expect(await sendLine()).toMatchObject({ line: outside, pasted: true })
  } finally {
    await restoreClipboard(run, saved)
  }
})

test('R66 caminho no topo do arquivo: clique copia; o lápis edita o caminho e abre outro arquivo (relativo, absoluto, com :linha)', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'src'))
  mkdirSync(join(env.project, 'lib'))
  writeFileSync(join(env.project, 'src', 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(env.project, 'lib', 'util.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n')
  writeFileSync(join(env.project, 'foto.png'), pngBytes())
  const run = await kora.launch(env)
  const page = run.page
  const header = () => page.locator('div.border-b').filter({ visible: true, has: page.locator(tip('Recarregar arquivo')) })
  const pencil = () => header().locator(tip('Editar caminho para abrir outro arquivo'))
  const input = () => header().getByLabel('Caminho do arquivo')

  await row(run, 'src').click()
  await row(run, 'src\\app.ts').click()
  await expect(ui.barTab(page, 'app.ts')).toBeVisible()

  const saved = await saveClipboard(run)
  try {
    await header().locator(tip('Clique para copiar o caminho')).click()
    await expect(header().getByRole('status')).toHaveText('Copiado')
    expect(await readClipboardText(run)).toBe('src\\app.ts')
  } finally {
    await restoreClipboard(run, saved)
  }

  await pencil().click()
  await expect(input()).toHaveValue('src\\app.ts')
  await page.keyboard.press('Escape')
  await expect(input()).toHaveCount(0)
  await expect(header().locator('[data-path]')).toHaveText('src\\app.ts')

  await pencil().click()
  await input().fill('src\\nada.ts')
  await page.keyboard.press('Enter')
  await expect(header().getByRole('alert')).toHaveText('Arquivo não encontrado neste projeto')
  await expect(input(), 'caminho errado mantém a edição aberta').toBeVisible()

  await input().fill('lib/util.ts:3')
  await page.keyboard.press('Enter')
  await expect(ui.barTab(page, 'util.ts')).toBeVisible()
  await expect(header().locator('[data-path]')).toHaveText('lib\\util.ts')
  await expect(row(run, 'lib\\util.ts'), 'o arquivo aberto aparece na árvore').toBeVisible()
  const editor = page.locator('.monaco-editor').filter({ visible: true })
  await expect(editor.locator('.active-line-number')).toHaveText('3')

  await pencil().click()
  await input().fill(join(env.project, 'foto.png'))
  await page.keyboard.press('Enter')
  await expect(ui.barTab(page, 'foto.png')).toBeVisible()
  await expect(header().locator('[data-path]')).toHaveText('foto.png')
})
