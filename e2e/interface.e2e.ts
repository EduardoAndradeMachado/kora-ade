import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './harness'
import {
  answerOpenDialog,
  installShellSpy,
  newTab,
  readClipboardText,
  readState,
  restoreClipboard,
  saveClipboard,
  shellCalls,
  starts,
  ui,
  waitFor,
  writeState,
  type KoraEnv
} from './kora'

const rightPanel = (page: import('@playwright/test').Page) => page.locator('aside').last()

test('R1 projetos adicionados na lateral persistem entre aberturas do app', async ({ kora }) => {
  const env = kora.env({ project: false })
  const second = join(env.root, 'outro-projeto')
  mkdirSync(second)
  const first = await kora.launch(env)
  await expect(first.page.getByText('Nenhum projeto ainda.')).toBeVisible()

  await answerOpenDialog(first, env.project)
  await first.page.getByTitle('Adicionar projeto').click()
  await expect(first.page.locator('aside nav').getByText('proj-teste')).toBeVisible()
  await answerOpenDialog(first, second)
  await first.page.getByTitle('Adicionar projeto').click()
  await expect(first.page.locator('aside nav').getByText('outro-projeto')).toBeVisible()
  await first.closeWindow()

  const again = await kora.launch(env)
  const names = await again.page.locator('aside nav [data-project-row] span.font-medium').allTextContents()
  expect(names).toEqual(['proj-teste', 'outro-projeto'])
  expect(readState(env).projects.map((p) => p.path)).toEqual([env.project, second])
})

test('R2 várias abas por projeto aparecem embaixo do projeto na lateral; projeto recolhe e expande', async ({ kora }) => {
  const env = kora.env()
  const other = join(env.root, 'outro')
  mkdirSync(other)
  writeState(env, {
    version: 2,
    projects: [
      { id: 'p1', name: 'proj-teste', path: env.project },
      { id: 'p2', name: 'outro', path: other }
    ],
    tabs: []
  })
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Terminal')
  await newTab(page, 'Terminal')
  await newTab(page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')

  await page.locator('aside nav div[title]').filter({ hasText: 'outro' }).click()
  await newTab(page, 'Terminal')
  await waitFor(() => readState(env).tabs.length === 4, 'quatro abas salvas')

  const groups = page.locator('aside nav > div')
  await expect(groups.nth(0).locator('div.ml-5')).toHaveCount(3)
  await expect(groups.nth(1).locator('div.ml-5')).toHaveCount(1)
  expect(readState(env).tabs.filter((t) => t.projectId === 'p1')).toHaveLength(3)

  await groups.nth(0).getByTitle('Recolher').click()
  await expect(groups.nth(0).locator('div.ml-5')).toHaveCount(0)
  await expect(groups.nth(0).locator('span.tabular-nums')).toHaveText('3')
  await groups.nth(0).getByTitle('Expandir').click()
  await expect(groups.nth(0).locator('div.ml-5')).toHaveCount(3)
})

test('R11 painel direito: nome do projeto no topo e abas Arquivos | Git | Sessões abaixo', async ({ kora }) => {
  const run = await kora.launch(kora.env())
  const panel = rightPanel(run.page)
  const header = panel.locator('span.font-semibold')
  await expect(header).toHaveText('proj-teste')
  const tabs = panel.locator('div.border-b').nth(1).locator('button')
  await expect(tabs).toHaveText(['Arquivos', 'Git', 'Sessões'])
  const h = (await header.boundingBox())!
  const t = (await tabs.first().boundingBox())!
  expect(h.y + h.height).toBeLessThanOrEqual(t.y)
})

test('R28 sem barra de título nativa: botões de janela sobre o topo, sem cobrir botões do app, com painel direito aberto e fechado', async ({ kora }) => {
  const run = await kora.launch(kora.env())
  const page = run.page
  const overlay = () =>
    page.evaluate(() => {
      const wco = (navigator as unknown as { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } })
        .windowControlsOverlay
      const r = wco?.getTitlebarAreaRect()
      return { visible: wco?.visible ?? false, right: r ? r.x + r.width : 0 }
    })
  const first = await overlay()
  expect(first.visible, 'a janela usa Window Controls Overlay (sem barra nativa)').toBe(true)
  expect(first.right).toBeLessThan(await page.evaluate(() => window.innerWidth))

  const refresh = (await rightPanel(page).getByTitle('Recarregar').boundingBox())!
  expect(refresh.x + refresh.width, 'Recarregar não pode ficar embaixo dos botões de janela').toBeLessThanOrEqual(first.right)

  await page.getByTitle('Esconder painel lateral').click()
  const toggle = (await page.getByTitle('Mostrar painel lateral').boundingBox())!
  expect(toggle.x + toggle.width, 'sem o painel, a barra de abas reserva o espaço').toBeLessThanOrEqual((await overlay()).right)
})

test('R29 Ctrl+W fecha só a aba atual: terminal rodando pede confirmação (Enter aceita); arquivo editado oferece Salvar e fechar', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'notas.txt'), 'antes\n')
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Terminal')
  await newTab(page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')
  await waitFor(() => readState(env).tabs.length === 2, 'duas abas salvas')
  const claudeTab = readState(env).tabs.find((t) => t.agent?.kind === 'claude')!

  await ui.terminal(page).click()
  await page.keyboard.press('Control+W')
  const dialog = page.locator('[role=dialog]')
  await expect(dialog).toContainText('Fechar o terminal')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(readState(env).tabs).toHaveLength(2)

  await ui.terminal(page).click()
  await page.keyboard.press('Control+W')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Enter')
  await waitFor(() => readState(env).tabs.length === 1, 'aba ativa fechada')
  expect(readState(env).tabs.map((t) => t.id)).not.toContain(claudeTab.id)
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)

  await rightPanel(page).locator('div[title="notas.txt"]').click()
  await expect(ui.barTab(page, 'notas.txt')).toBeVisible()
  const editor = page.locator('.monaco-editor').filter({ visible: true })
  await expect(editor).toContainText('antes')
  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('depois')
  await expect(editor).toContainText('depois')
  await page.keyboard.press('Control+W')
  await expect(dialog).toContainText('Salvar "notas.txt" antes de fechar?')
  await dialog.getByRole('button', { name: 'Salvar e fechar' }).click()
  await expect(ui.barTab(page, 'notas.txt')).toHaveCount(0)
  expect(readFileSync(join(env.project, 'notas.txt'), 'utf8')).toBe('antes\ndepois')
})

test('R30 arrastar: abas reordenam na barra e na lateral juntas; projeto arrastado para Ocultos some da lista e volta pelo menu', async ({ kora }) => {
  const env = kora.env()
  const other = join(env.root, 'outro')
  mkdirSync(other)
  writeState(env, {
    version: 2,
    projects: [
      { id: 'p1', name: 'proj-teste', path: env.project },
      { id: 'p2', name: 'outro', path: other }
    ],
    tabs: [
      { id: 't1', projectId: 'p1', title: 'Um', titleLocked: true, agent: null },
      { id: 't2', projectId: 'p1', title: 'Dois', titleLocked: true, agent: null },
      { id: 't3', projectId: 'p1', title: 'Tres', titleLocked: true, agent: null }
    ]
  })
  const run = await kora.launch(env)
  const page = run.page
  const barTitles = () => ui.tabBar(page).locator('div.group').allTextContents()
  const sideTitles = () => page.locator('aside nav div.ml-5').allTextContents()
  await expect.poll(barTitles).toEqual(['Um', 'Dois', 'Tres'])

  const um = ui.barTab(page, 'Um')
  const tres = ui.barTab(page, 'Tres')
  const box = (await tres.boundingBox())!
  await um.dragTo(tres, { targetPosition: { x: box.width - 4, y: box.height / 2 } })
  await expect.poll(barTitles).toEqual(['Dois', 'Tres', 'Um'])
  await expect.poll(sideTitles).toEqual(['Dois', 'Tres', 'Um'])
  await waitFor(() => readState(env).tabs.map((t) => t.id).join() === 't2,t3,t1', 'ordem das abas salva')

  const sideTres = ui.sideTab(page, 'Tres')
  await ui.sideTab(page, 'Um').dragTo(sideTres, { targetPosition: { x: 10, y: 2 } })
  await expect.poll(barTitles).toEqual(['Dois', 'Um', 'Tres'])

  const projectRow = page.locator('aside nav div[title]').filter({ hasText: 'outro' })
  await projectRow.dragTo(page.locator('aside nav').getByText('Ocultos', { exact: true }))
  await waitFor(() => readState(env).projects.find((p) => p.id === 'p2')?.hidden === true, 'projeto oculto salvo')
  await expect(projectRow).toHaveCount(0)
  const hiddenLabel = page.locator('aside nav').getByText('Ocultos', { exact: true })
  await hiddenLabel.click()
  await expect(projectRow).toBeVisible()

  await projectRow.click({ button: 'right' })
  await ui.menuItem(page, 'Mover para Ativos').click()
  await waitFor(() => readState(env).projects.find((p) => p.id === 'p2')?.hidden === false, 'projeto de volta aos ativos')
  await hiddenLabel.click()
  await expect(page.getByTitle('Expandir ocultos')).toBeVisible()
  await expect(projectRow).toBeVisible()
})

test('R34 controle visível de tamanho: interface e texto do terminal mudam separados pelo painel Aa', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Terminal')
  const zoomFactor = () => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())
  // O xterm dimensiona o textarea auxiliar pela célula: a altura dele acompanha o tamanho da fonte.
  const cellHeight = () =>
    page.evaluate(() => (document.querySelector('.xterm-helper-textarea') as HTMLElement | null)?.offsetHeight ?? 0)
  await expect.poll(cellHeight).toBeGreaterThan(0)
  const initialCell = await cellHeight()

  const open = page.getByTitle('Tamanho da interface, do terminal e dos arquivos')
  await expect(open).toContainText('100% · 14 px')
  await open.click()
  const panel = page.getByRole('dialog', { name: 'Tamanhos' })
  await panel.getByTitle('Aumentar texto do terminal').click()
  await panel.getByTitle('Aumentar texto do terminal').click()
  await expect.poll(cellHeight).toBeGreaterThan(initialCell)

  expect(await zoomFactor()).toBeCloseTo(1)

  await panel.getByTitle('Aumentar interface').click()
  await expect.poll(zoomFactor).toBeCloseTo(1.1)
  await waitFor(() => readState(env).settings?.zoom === 1.1 && readState(env).settings?.terminalFontSize === 16, 'tamanhos salvos')

  await panel.getByTitle('Voltar ao padrão').first().click()
  await expect.poll(zoomFactor).toBeCloseTo(1)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(open).toContainText('100% · 16 px')
})

test('R38 botões de janela acompanham o tema que a interface desenhou (claro e escuro)', async ({ kora }) => {
  const run = await kora.launch(kora.env())
  const page = run.page
  await run.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const g = globalThis as unknown as { __overlays: string[] }
    g.__overlays = []
    const original = win.setTitleBarOverlay.bind(win)
    win.setTitleBarOverlay = (options) => {
      g.__overlays.push(`${options.color}/${options.symbolColor}`)
      original(options)
    }
  })
  const last = () => run.app.evaluate(() => (globalThis as unknown as { __overlays: string[] }).__overlays.at(-1) ?? '')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(last).toBe('#16171b/#eceef2')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(last).toBe('#f6f7f9/#15171b')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 247, 249)')
})

test('R39 clique no nome do projeto: com abas recolhe e expande como a setinha; sem abas mostra os botões para abrir o agente', async ({ kora }) => {
  const env = kora.env()
  const other = join(env.root, 'vazio')
  mkdirSync(other)
  writeState(env, {
    version: 2,
    projects: [
      { id: 'p1', name: 'proj-teste', path: env.project },
      { id: 'p2', name: 'vazio', path: other }
    ],
    tabs: [
      { id: 't1', projectId: 'p1', title: 'Um', titleLocked: true, agent: null },
      { id: 't2', projectId: 'p1', title: 'Dois', titleLocked: true, agent: null }
    ]
  })
  const run = await kora.launch(env)
  const page = run.page
  const groups = page.locator('aside nav > div').filter({ has: page.locator('[data-project-row]') })
  const name = (text: string) => page.locator('[data-project-row]').filter({ hasText: text }).locator('span.font-medium')
  await expect(groups.nth(0).locator('div.ml-5')).toHaveCount(2)

  await name('proj-teste').click()
  await expect(groups.nth(0).locator('div.ml-5')).toHaveCount(0)
  await name('proj-teste').click()
  await expect(groups.nth(0).locator('div.ml-5')).toHaveCount(2)

  await name('vazio').click()
  const main = page.locator('main')
  await expect(main.getByText('vazio', { exact: true })).toBeVisible()
  for (const label of ['Claude', 'Codex', 'Terminal']) await expect(main.getByRole('button', { name: label, exact: true })).toBeVisible()
  await main.getByRole('button', { name: 'Claude', exact: true }).click()
  await waitFor(() => starts(env, 'claude')[0], 'claude aberto pela tela do projeto vazio')
  await waitFor(() => readState(env).tabs.some((t) => t.projectId === 'p2'), 'aba do projeto vazio salva')
})

test('R40 categorias: criar, subcategoria, arrastar projetos, recolher pelo nome, renomear, ocultar a categoria inteira, persistir e excluir', async ({ kora }) => {
  const env = kora.env()
  for (const name of ['outro', 'terceiro']) mkdirSync(join(env.root, name))
  writeState(env, {
    version: 2,
    projects: [
      { id: 'p1', name: 'proj-teste', path: env.project },
      { id: 'p2', name: 'outro', path: join(env.root, 'outro') },
      { id: 'p3', name: 'terceiro', path: join(env.root, 'terceiro') }
    ],
    tabs: []
  })
  let run = await kora.launch(env)
  let page = run.page
  const nav = () => page.locator('aside nav')
  const groupRow = (name: string) => page.locator('[data-group-row]').filter({ hasText: name })
  const projectRow = (name: string) => page.locator('[data-project-row]').filter({ hasText: name })
  const saved = () => readState(env) as ReturnType<typeof readState> & { groups?: { id: string; name: string; parentId?: string; hidden?: boolean; collapsed?: boolean }[] }
  const menu = (label: string) => ui.menuItem(page, label).click()

  await page.getByTitle('Nova categoria').click()
  await nav().getByPlaceholder('nome da categoria').fill('Empresa A')
  await nav().getByPlaceholder('nome da categoria').press('Enter')
  await expect(groupRow('Empresa A')).toBeVisible()
  const empresa = await waitFor(() => saved().groups?.find((g) => g.name === 'Empresa A'), 'categoria salva')

  await projectRow('outro').dragTo(groupRow('Empresa A'))
  await waitFor(() => saved().projects.find((p) => p.id === 'p2')?.groupId === empresa.id, 'projeto dentro da categoria')

  await groupRow('Empresa A').click({ button: 'right' })
  await menu('Nova subcategoria')
  await nav().getByPlaceholder('nome da subcategoria').fill('Cliente X')
  await nav().getByPlaceholder('nome da subcategoria').press('Enter')
  const cliente = await waitFor(() => saved().groups?.find((g) => g.name === 'Cliente X'), 'subcategoria salva')
  expect(cliente.parentId).toBe(empresa.id)
  await projectRow('terceiro').dragTo(groupRow('Cliente X'))
  await waitFor(() => saved().projects.find((p) => p.id === 'p3')?.groupId === cliente.id, 'projeto na subcategoria')
  const indent = async (name: string) => (await projectRow(name).boundingBox())!.x
  expect(await indent('terceiro')).toBeGreaterThan(await indent('outro'))
  expect(await indent('outro')).toBeGreaterThan(await indent('proj-teste'))

  await groupRow('Empresa A').locator('span.font-medium').click()
  await expect(projectRow('outro')).toHaveCount(0)
  await expect(projectRow('terceiro')).toHaveCount(0)
  await groupRow('Empresa A').locator('span.font-medium').click()
  await expect(projectRow('terceiro')).toBeVisible()

  await groupRow('Empresa A').locator('span.font-medium').dblclick()
  const rename = page.locator('[data-group-row] input')
  await rename.fill('Empresa B')
  await rename.press('Enter')
  await waitFor(() => saved().groups?.find((g) => g.id === empresa.id)?.name === 'Empresa B', 'categoria renomeada')

  await groupRow('Empresa B').click({ button: 'right' })
  await menu('Ocultar categoria')
  await waitFor(() => saved().groups?.find((g) => g.id === empresa.id)?.hidden === true, 'categoria oculta')
  await expect(groupRow('Empresa B')).toHaveCount(0)
  await expect(nav().getByText('Ocultos', { exact: true }).locator('..')).toContainText('2')

  await run.closeWindow()
  run = await kora.launch(env)
  page = run.page
  await nav().getByText('Ocultos', { exact: true }).click()
  await expect(groupRow('Empresa B')).toBeVisible()
  await expect(projectRow('terceiro')).toBeVisible()
  await groupRow('Empresa B').click({ button: 'right' })
  await menu('Mostrar categoria')
  await waitFor(() => saved().groups?.find((g) => g.id === empresa.id)?.hidden === false, 'categoria de volta')

  // Tirar da categoria: durante o arrasto aparece a faixa no topo, e soltar nela devolve o item ao nível principal.
  const dragToRoot = async (source: import('@playwright/test').Locator, text: string): Promise<void> => {
    const from = (await source.boundingBox())!
    await page.mouse.move(from.x + 20, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + 24, from.y + from.height / 2 + 6, { steps: 4 })
    const strip = page.locator('[data-root-drop]')
    await expect(strip).toHaveText(text)
    const to = (await strip.boundingBox())!
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(strip).toHaveCount(0)
  }
  await dragToRoot(projectRow('terceiro'), 'Solte aqui para tirar da categoria')
  await waitFor(() => saved().projects.find((p) => p.id === 'p3')?.groupId === undefined, 'projeto tirado da subcategoria pela faixa')
  expect(await indent('terceiro')).toBe(await indent('proj-teste'))
  await dragToRoot(groupRow('Cliente X'), 'Solte aqui para virar categoria principal')
  await waitFor(() => saved().groups?.find((g) => g.id === cliente.id)?.parentId === undefined, 'subcategoria virou categoria principal')

  await groupRow('Empresa B').click({ button: 'right' })
  await menu('Excluir categoria')
  await page.locator('[role=dialog]').getByRole('button', { name: 'Excluir categoria' }).click()
  await waitFor(() => !saved().groups?.some((g) => g.id === empresa.id), 'categoria excluída')
  expect(saved().groups?.some((g) => g.id === cliente.id)).toBe(true)
  expect(saved().projects.find((p) => p.id === 'p2')?.groupId).toBeUndefined()
  expect(existsSync(join(env.root, 'outro'))).toBe(true)
})

test('R41 reordenar categorias arrastando: borda de cima põe antes, borda de baixo põe depois, meio põe dentro', async ({ kora }) => {
  const env = kora.env()
  const state = {
    version: 2 as const,
    projects: [{ id: 'p1', name: 'proj-teste', path: env.project }],
    tabs: [],
    groups: [
      { id: 'a', name: 'Alfa' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'Gama' }
    ]
  }
  writeState(env, state as Parameters<typeof writeState>[1])
  const run = await kora.launch(env)
  const page = run.page
  const groupRow = (name: string) => page.locator('[data-group-row]').filter({ hasText: name })
  const order = () => page.locator('[data-group-row] span.font-medium').allTextContents()
  const saved = () => readState(env) as ReturnType<typeof readState> & { groups?: { id: string; parentId?: string }[] }
  await expect.poll(order).toEqual(['Alfa', 'Beta', 'Gama'])

  const dragGroup = async (from: string, to: string, at: number, hint: string): Promise<void> => {
    const source = (await groupRow(from).boundingBox())!
    const target = (await groupRow(to).boundingBox())!
    await page.mouse.move(source.x + 30, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + 34, source.y + source.height / 2 + 4, { steps: 3 })
    await page.mouse.move(target.x + 40, target.y + target.height * at, { steps: 8 })
    await page.mouse.up()
    // O rótulo (${hint}) só existe no meio do arrasto; depois de soltar não pode sobrar em nenhuma categoria.
    await expect(page.locator('[data-drop-hint]'), hint).toHaveCount(0)
  }

  await dragGroup('Gama', 'Alfa', 0.1, 'Soltar antes')
  await expect.poll(order).toEqual(['Gama', 'Alfa', 'Beta'])
  await dragGroup('Gama', 'Beta', 0.9, 'Soltar depois')
  await expect.poll(order).toEqual(['Alfa', 'Beta', 'Gama'])
  expect(saved().groups?.map((g) => g.id)).toEqual(['a', 'b', 'c'])

  await dragGroup('Gama', 'Alfa', 0.5, 'Soltar dentro')
  await waitFor(() => saved().groups?.find((g) => g.id === 'c')?.parentId === 'a', 'Gama dentro de Alfa')
  const x = async (name: string) => (await groupRow(name).locator('span.font-medium').boundingBox())!.x
  expect(await x('Gama')).toBeGreaterThan(await x('Alfa'))
})

function seedSessions(env: KoraEnv): { claudeId: string; codexId: string } {
  const claudeId = randomUUID()
  const codexId = randomUUID()
  const dir = join(env.home, '.claude', 'projects', env.project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${claudeId}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'pedido de teste' }, isSidechain: false }) +
      '\n' +
      JSON.stringify({ type: 'ai-title', aiTitle: 'Conversa Claude semeada', sessionId: claudeId }) +
      '\n'
  )
  const day = join(env.home, '.codex', 'sessions', '2026', '09', '24')
  mkdirSync(day, { recursive: true })
  writeFileSync(
    join(day, `rollout-2026-09-24T10-00-00-${codexId}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd: env.project, originator: 'codex-tui' } }) +
      '\n' +
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pedido codex' }] } }) +
      '\n'
  )
  appendFileSync(
    join(env.home, '.codex', 'session_index.jsonl'),
    JSON.stringify({ id: codexId, thread_name: 'Conversa Codex semeada', updated_at: new Date().toISOString() }) + '\n'
  )
  return { claudeId, codexId }
}

test('R31 apagar conversa: lixeira na aba Sessões com confirmação; conversa ligada a uma aba é recusada pelo main', async ({ kora }) => {
  const env = kora.env()
  const { claudeId, codexId } = seedSessions(env)
  const claudeFile = join(env.home, '.claude', 'projects', env.project.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeId}.jsonl`)
  const codexFile = join(env.home, '.codex', 'sessions', '2026', '09', '24', `rollout-2026-09-24T10-00-00-${codexId}.jsonl`)
  const run = await kora.launch(env)
  const page = run.page
  const panel = rightPanel(page)
  await panel.getByRole('button', { name: 'Sessões' }).click()
  const claudeRow = panel.locator('div.group').filter({ hasText: 'Conversa Claude semeada' })
  const codexRow = panel.locator('div.group').filter({ hasText: 'Conversa Codex semeada' })

  await claudeRow.hover()
  await claudeRow.getByTitle('Apagar conversa').click()
  const dialog = page.locator('[role=dialog]')
  await expect(dialog).toContainText('Lixeira')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  expect(existsSync(claudeFile)).toBe(true)

  await claudeRow.hover()
  await claudeRow.getByTitle('Apagar conversa').click()
  await dialog.getByRole('button', { name: 'Apagar conversa' }).click()
  await expect.poll(() => existsSync(claudeFile)).toBe(false)
  await expect(claudeRow).toHaveCount(0)

  await codexRow.hover()
  await codexRow.getByTitle('Fixar como aba sem abrir agora').click()
  await waitFor(() => readState(env).tabs.find((t) => t.agent?.sessionId === codexId), 'aba fixada salva')
  await expect(codexRow.getByTitle('Apagar conversa')).toHaveCount(0)
  const refused = await page.evaluate(
    (id) => window.kora.deleteSession('p1', { kind: 'codex', sessionId: id }).then(() => 'apagou', (e: Error) => e.message),
    codexId
  )
  expect(refused).toMatch(/Feche a aba antes de apagar/)
  expect(existsSync(codexFile)).toBe(true)
})

test('R12 Sessões: lista conversas do Claude e do Codex; clicar abre e retoma; alfinete fixa sem abrir; aberta leva à aba existente', async ({ kora }) => {
  const env = kora.env()
  const { claudeId, codexId } = seedSessions(env)
  const run = await kora.launch(env)
  const page = run.page
  const panel = rightPanel(page)
  await panel.getByRole('button', { name: 'Sessões' }).click()

  const claudeRow = panel.locator('div.group').filter({ hasText: 'Conversa Claude semeada' })
  const codexRow = panel.locator('div.group').filter({ hasText: 'Conversa Codex semeada' })
  await expect(claudeRow).toBeVisible()
  await expect(codexRow).toBeVisible()

  await claudeRow.click()
  const resumed = await waitFor(() => starts(env, 'claude')[0], 'claude falso retomado pela lista')
  expect(resumed.args).toEqual(['--resume', claudeId])
  await expect(ui.sideTab(page, /.+/)).toHaveCount(1)

  await codexRow.hover()
  await codexRow.getByTitle('Fixar como aba sem abrir agora').click()
  await expect(ui.sideTab(page, /.+/)).toHaveCount(2)
  await expect(ui.visibleButton(page, 'Continuar chat')).toBeVisible()
  await waitFor(() => readState(env).tabs.find((t) => t.agent?.sessionId === codexId), 'aba fixada salva')
  await page.waitForTimeout(1000)
  expect(starts(env, 'codex')).toHaveLength(0)

  await expect(claudeRow).toContainText('aberta numa aba')
  await claudeRow.click()
  await expect(ui.sideTab(page, /.+/)).toHaveCount(2)
  await expect(ui.visibleButton(page, 'Continuar chat')).toHaveCount(0)
  await expect(ui.terminal(page)).toBeVisible()
  expect(starts(env, 'claude')).toHaveLength(1)
})

test('R15 clique direito no projeto: itens, copiar caminho, Explorer, remover com diálogo próprio sem apagar a pasta', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'arquivo.txt'), 'fica')
  const run = await kora.launch(env)
  const page = run.page
  await installShellSpy(run)
  const row = page.locator('aside nav div[title]').first()

  // Sem botão de remover na linha do projeto.
  await row.hover()
  const titles = await row.locator('button').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
  expect(titles.every((t) => t === 'Nova aba' || t === 'Recolher' || t === 'Expandir')).toBe(true)

  await row.click({ button: 'right' })
  const items = await page.locator('body > div.fixed button').allTextContents()
  expect(items).toEqual([
    'Nova aba Claude',
    'Nova aba Codex',
    'Novo terminal',
    'Atualizar ícone',
    'Abrir no Explorer',
    'Copiar caminho',
    'Ocultar',
    'Remover da lista'
  ])
  await ui.menuItem(page, 'Nova aba Claude').click()
  await waitFor(() => starts(env, 'claude')[0], 'nova aba Claude pelo menu do projeto')

  const saved = await saveClipboard(run)
  try {
    await row.click({ button: 'right' })
    await ui.menuItem(page, 'Copiar caminho').click()
    await expect.poll(() => readClipboardText(run)).toBe(env.project)
  } finally {
    await restoreClipboard(run, saved)
  }

  await row.click({ button: 'right' })
  await ui.menuItem(page, 'Abrir no Explorer').click()
  await expect.poll(() => shellCalls(run)).toContainEqual(['openPath', env.project])

  await row.click({ button: 'right' })
  await ui.menuItem(page, 'Atualizar ícone').click()
  await expect(page.locator('main').getByText(/erro/i)).toHaveCount(0)

  await row.click({ button: 'right' })
  await ui.menuItem(page, 'Remover da lista').click()
  const dialog = page.locator('[role=dialog]')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('A pasta e os arquivos continuam no computador')
  await expect(dialog).toContainText('1 terminal aberto será fechado.')
  await dialog.getByRole('button', { name: 'Remover da lista' }).click()
  await expect(page.locator('aside nav div[title]')).toHaveCount(0)
  await waitFor(() => readState(env).projects.length === 0, 'projeto removido do estado')
  expect(readState(env).tabs).toHaveLength(0)
  expect(existsSync(join(env.project, 'arquivo.txt'))).toBe(true)
  expect(readdirSync(env.project)).toContain('arquivo.txt')
  expect(await run.nativeDialogs()).toEqual([])
})

test('R24 sem barra de rolagem nativa e sem diálogos nativos nos fluxos de confirmação', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'apagar.txt'), 'x')
  writeFileSync(join(env.project, 'codigo.ts'), 'export const a = 1\n')
  const run = await kora.launch(env)
  const page = run.page

  const widths = await page.evaluate(() => {
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:120px;overflow:scroll'
    box.innerHTML = '<div style="height:1000px;width:1000px"></div>'
    document.body.appendChild(box)
    const w = box.offsetWidth - box.clientWidth
    box.remove()
    const rules = [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText)
      } catch {
        return []
      }
    })
    return { scrollbar: w, hasRule: rules.some((r) => r.includes('::-webkit-scrollbar')) }
  })
  expect(widths.hasRule).toBe(true)
  expect(widths.scrollbar).toBe(8)

  const panel = rightPanel(page)
  // Excluir no explorador: diálogo do app.
  await panel.locator('div[title="apagar.txt"]').click({ button: 'right' })
  await ui.menuItem(page, 'Excluir').click()
  await expect(page.locator('[role=dialog]')).toContainText('Lixeira')
  await page.locator('[role=dialog]').getByRole('button', { name: 'Cancelar' }).click()

  // Fechar editor com alteração não salva: diálogo do app.
  await panel.locator('div[title="codigo.ts"]').click()
  await expect(page.locator('.monaco-editor').filter({ visible: true })).toBeVisible()
  await page.locator('.monaco-editor .view-lines').filter({ visible: true }).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' // sujo')
  await ui.barTab(page, 'codigo.ts').getByTitle('Fechar aba').click()
  await expect(page.locator('[role=dialog]')).toContainText('sem salvar')
  await page.locator('[role=dialog]').getByRole('button', { name: 'Cancelar' }).click()

  // Recarregar arquivo com alteração não salva.
  await page.getByTitle('Recarregar arquivo').filter({ visible: true }).click()
  await page.waitForTimeout(500)

  const native = await run.nativeDialogs()
  expect(native, 'nenhum diálogo nativo (window.confirm/alert ou dialog do Electron) deve aparecer').toEqual([])
})

test('R44 clique com o botão do meio fecha a aba, na barra de cima e na lateral', async ({ kora }) => {
  const env = kora.env()
  writeState(env, {
    version: 2,
    projects: [{ id: 'p1', name: 'proj-teste', path: env.project }],
    tabs: [
      { id: 't1', projectId: 'p1', title: 'Um', titleLocked: true, agent: null },
      { id: 't2', projectId: 'p1', title: 'Dois', titleLocked: true, agent: null }
    ]
  })
  const run = await kora.launch(env)
  const page = run.page
  await expect(ui.sideTab(page, 'Um')).toBeVisible()

  await ui.sideTab(page, 'Um').click({ button: 'middle' })
  await waitFor(() => readState(env).tabs.map((t) => t.id).join() === 't2', 'aba da lateral fechada')
  await expect(ui.barTab(page, 'Um')).toHaveCount(0)

  await ui.barTab(page, 'Dois').click({ button: 'middle' })
  await waitFor(() => readState(env).tabs.length === 0, 'aba da barra fechada')
  await expect(ui.sideTab(page, 'Dois')).toHaveCount(0)
})

test('R45 tema: o seletor chama o modo que segue o sistema de "Sistema"', async ({ kora }) => {
  const run = await kora.launch(kora.env())
  const page = run.page
  await page.getByTitle('Tema').click()
  await expect(ui.menuItem(page, '● Sistema')).toBeVisible()
  await expect(page.getByText('Seguir o Windows')).toHaveCount(0)
})

test('R53 voltar para um projeto onde uma aba foi renomeada antes não reabre a edição do nome (clique vai para a aba, não para o título)', async ({ kora }) => {
  const env = kora.env()
  const other = join(env.root, 'outro')
  mkdirSync(other)
  writeState(env, {
    version: 2,
    projects: [
      { id: 'p1', name: 'proj-teste', path: env.project },
      { id: 'p2', name: 'outro', path: other }
    ],
    tabs: [
      { id: 'a1', projectId: 'p1', title: 'A1', titleLocked: true, agent: null },
      { id: 'a2', projectId: 'p1', title: 'A2', titleLocked: true, agent: null },
      { id: 'b1', projectId: 'p2', title: 'B1', titleLocked: true, agent: null },
      { id: 'b2', projectId: 'p2', title: 'B2', titleLocked: true, agent: null }
    ]
  })
  const run = await kora.launch(env)
  const page = run.page
  const editing = ui.tabBar(page).locator('input')

  await ui.sideTab(page, 'A1').click()
  await page.keyboard.press('F2')
  await expect(editing).toBeVisible()
  await editing.fill('A1 renomeada')
  await editing.press('Enter')
  await expect(editing).toHaveCount(0)
  await waitFor(() => readState(env).tabs.find((t) => t.title === 'A1 renomeada'), 'nome novo salvo')

  await ui.sideTab(page, 'B1').click()
  await expect(ui.barTab(page, 'B1')).toBeVisible()
  await ui.sideTab(page, 'A2').click()
  await expect(ui.barTab(page, 'A2')).toBeVisible()
  await page.waitForTimeout(300)
  await expect(editing, 'nenhum título em edição depois de voltar ao projeto').toHaveCount(0)

  await ui.sideTab(page, 'B2').click()
  await ui.sideTab(page, 'A1 renomeada').click()
  await page.waitForTimeout(300)
  await expect(editing).toHaveCount(0)
})

test('R60 digitar e fechar na hora (Ctrl+W ou X da janela) pergunta antes de perder a edição', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'notas.txt'), 'antes\n')
  const run = await kora.launch(env)
  const page = run.page
  const dialog = page.locator('[role=dialog]')
  const openAndType = async (): Promise<void> => {
    await rightPanel(page).locator('div[title="notas.txt"]').click()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await expect(editor).toContainText('antes')
    await editor.locator('.view-lines').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('z')
  }

  // Sem esperar a tela mostrar "Não salvo": é a corrida entre a edição e o atalho que perdia o texto.
  for (let round = 0; round < 3; round++) {
    await openAndType()
    await page.keyboard.press('Control+W')
    await expect(dialog, `rodada ${round + 1}: Ctrl+W logo depois de digitar pergunta`).toContainText('Salvar "notas.txt" antes de fechar?')
    await dialog.getByRole('button', { name: 'Fechar sem salvar' }).click()
    await expect(ui.barTab(page, 'notas.txt')).toHaveCount(0)
  }

  await openAndType()
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect(dialog, 'X logo depois de digitar pergunta').toContainText('Salvar "notas.txt" antes de fechar?')
  await dialog.getByRole('button', { name: 'Salvar e fechar' }).click()
  await expect.poll(() => readFileSync(join(env.project, 'notas.txt'), 'utf8')).toBe('antes\nz')
})

test('R64 diálogo aberto escurece também os botões de janela (desenhados pelo Windows, fora do véu da página)', async ({ kora }) => {
  const run = await kora.launch(kora.env())
  const page = run.page
  await run.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const g = globalThis as unknown as { __overlays: string[] }
    g.__overlays = []
    const original = win.setTitleBarOverlay.bind(win)
    win.setTitleBarOverlay = (options) => {
      g.__overlays.push(`${options.color}/${options.symbolColor}`)
      original(options)
    }
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'light' })
  const last = () => run.app.evaluate(() => (globalThis as unknown as { __overlays: string[] }).__overlays.at(-1) ?? '')
  const normal = '#f6f7f9/#15171b'
  // Fundo e símbolos claros misturados com preto a 50%, como o véu bg-black/50 dos diálogos.
  const dimmed = '#7b7c7d/#0b0c0e'
  await expect.poll(last).toBe(normal)

  await page.getByTitle('Configurações').click()
  await expect.poll(last, 'Configurações abertas').toBe(dimmed)
  await page.keyboard.press('Escape')
  await expect.poll(last, 'Configurações fechadas').toBe(normal)

  await page.locator('aside nav [data-project-row]').first().click({ button: 'right' })
  await ui.menuItem(page, 'Remover da lista').click()
  await expect(page.locator('[role=dialog]')).toBeVisible()
  await expect.poll(last, 'confirmação aberta').toBe(dimmed)
  await page.locator('[role=dialog]').getByRole('button', { name: 'Cancelar' }).click()
  await expect.poll(last, 'confirmação fechada').toBe(normal)
})
