import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect as browserExpect } from '@playwright/test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { it, expect } from 'vitest'
import { MobileServer } from '../src/main/mobile-server'
import { MobileRuntime } from '../src/main/mobile-runtime'
import { Terminals } from '../src/main/terminals'
import { DESKTOP } from '../src/main/terminal-sizes'
import { emptyState } from '../src/shared/state'
import { findProjectIcon } from '../src/main/project-icon'

const SIZES = [[350, 700], [768, 1024], [1280, 800]] as const

it('pareia no navegador, usa o mesmo PowerShell que o PC e funciona em celular, tablet e desktop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kora-mobile-ui-'))
  // Mesmas dependências preparadas de antemão do electron.vite.config: descobertas no meio, o Vite recarregaria a página.
  const optimizeDeps = { include: ['react', 'react-dom', 'react-dom/client', 'marked', 'dompurify', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-unicode11', 'codemirror', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/language-data', '@codemirror/theme-one-dark', 'pdfjs-dist'] }
  const vite = await createServer({ configFile: false, root: resolve('src/renderer'), cacheDir: join(dir, 'vite-cache'), optimizeDeps, plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false }, resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } } })
  await vite.listen()
  const devUrl = vite.resolvedUrls!.local[0]!
  let state = { ...emptyState(), projects: [{ id: 'p', name: 'Projeto de validação', path: dir }] }
  let desktop = ''
  let activeAccount = 'pessoal'
  // Codex falso: abre a tela cheia com mouse ligado e fica parado, como o Codex de verdade antes da primeira mensagem.
  const fakeCodex = join(dir, 'codex-falso.cjs')
  writeFileSync(fakeCodex, "process.stdout.write('\\x1b[?1049h\\x1b[?1003h\\x1b[?1006hTELA_CHEIA'); setInterval(() => {}, 1000)", 'utf8')
  writeFileSync(join(dir, 'codex.cmd'), `@"${process.execPath}" "${fakeCodex}"\r\n`, 'utf8')
  const originalPath = process.env['PATH']
  process.env['PATH'] = `${dir};${originalPath}`
  const written: { id: string; data: string }[] = []
  const terminals = new Terminals({
    onData: (id, data, sequence) => { desktop += data; mobile.publishData(id, data, sequence) },
    onExit: () => mobile.publishState()
  })
  terminals.setMirroring(true)
  const write = terminals.write.bind(terminals)
  terminals.write = (id, data) => { written.push({ id, data }); write(id, data) }
  const submitted: { text: string; images: string[] }[] = []
  const submit = terminals.submit.bind(terminals)
  terminals.submit = (id, text, agent, images = []) => { submitted.push({ text, images }); submit(id, text, agent, images) }
  const runtime: MobileRuntime = new MobileRuntime({
    state: () => state, commit: (next) => { state = next }, terminals, activities: new Map(),
    launch: (tab, cols, rows, how) => terminals.spawn(tab.id, dir, cols, rows, how.type === 'codex' ? { kind: 'codex', mode: 'new' } : undefined),
    changed: () => mobile.publishState(),
    sized: (id, change) => mobile.publishSize({ id, ...change }),
    icon: async (_id, path) => (await findProjectIcon(path))?.dataUrl ?? null,
    usage: async () => [{ agent: 'claude', windows: [{ label: '5 h', usedPercent: 91, resetsAt: Date.now() + 5_400_000, windowMinutes: 300 }, { label: 'Semanal', usedPercent: 30, resetsAt: Date.now() + 86_400_000, windowMinutes: 10080 }], updatedAt: Date.now(), source: 'api' }],
    accounts: async () => ({ activeUnknown: false, login: null, accounts: ['pessoal', 'trabalho'].map((id) => ({ id, email: `${id}@exemplo.com`, organizationName: null, subscriptionType: 'max', refreshTokenExpiresAt: null, weekly: null, active: id === activeAccount })) }),
    switchAccount: async (id) => { activeAccount = id }
  })
  const mobile: MobileServer = new MobileServer({ configFile: join(dir, 'mobile.json'), rendererDir: resolve('src/renderer'), imageDir: join(dir, 'imagens'), devUrl, devAssetRoots: [resolve('node_modules'), resolve('src/shared'), join(dir, 'vite-cache')], runtime, changed: () => {}, port: 0 })
  const browser = await chromium.launch({ headless: true })
  try {
    await mobile.start()
    const port = (mobile as unknown as { port: number }).port
    const invitation = mobile.pairing.invite()
    const context = await browser.newContext({ viewport: { width: 350, height: 700 }, isMobile: true, hasTouch: true, colorScheme: 'dark' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}/#pair=${invitation.code}`)
    // Primeira carga: o Vite prepara as dependências (CodeMirror, pdf.js) antes de servir a página, mais lento no CI.
    await browserExpect(page.getByRole('button', { name: 'Vincular celular' })).toBeVisible({ timeout: 45000 })
    await page.getByRole('button', { name: 'Vincular celular' }).click()
    await browserExpect(page.getByRole('heading', { name: 'Seus projetos' })).toBeVisible()
    const { deviceId: device } = await page.evaluate(async () => (await fetch('/api/state')).json())
    await page.getByRole('button', { name: 'Projeto de validação', exact: true }).click()
    await browserExpect(page.getByRole('button', { name: 'Nova aba', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Nova aba', exact: true }).click()
    const options = page.getByRole('dialog').locator('.new-tab-option')
    await browserExpect(options).toHaveText([/^Claude/, /^Codex/, /^OpenCode/, /^Terminal/])
    await browserExpect(options.first().getByLabel('Claude', { exact: true })).toBeVisible()
    await options.filter({ hasText: /^Terminal/ }).click()
    await browserExpect(page.locator('.xterm-screen')).toBeVisible()
    const tab = runtime.snapshot().tabs[0]!
    const pid = terminals.pids().get(tab.id)
    await expect.poll(() => runtime.sizes.holder(tab.id)).toBe(device)
    const artifacts = resolve('e2e/.results/mobile-validation')
    mkdirSync(artifacts, { recursive: true })

    // Mensagem do celular e comando digitado no PC vão para o mesmo shell; o celular vê os dois.
    await page.getByRole('textbox', { name: 'Mensagem para a sessão' }).fill("Write-Output ('UI_MOBILE_' + 'WORKS')")
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect.poll(() => desktop, { timeout: 15000 }).toContain('UI_MOBILE_WORKS')
    terminals.write(tab.id, "Write-Output ('DIGITADO_' + 'NO_PC')\r")
    await browserExpect(page.locator('.xterm-rows')).toContainText('DIGITADO_NO_PC', { timeout: 15000 })
    await browserExpect(page.locator('.xterm-rows')).toContainText('UI_MOBILE_WORKS')

    // A barra de teclas manda as teclas que o teclado do celular não tem.
    await page.getByRole('textbox', { name: 'Mensagem para a sessão' }).fill("Write-Output ('DORMINDO_' + 'AGORA'); Start-Sleep 30; Write-Output ('NAO_' + 'TERMINOU')")
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    // Com o PowerShell ainda lendo a linha, o ^C vira tecla e não interrompe; espera o comando rodar.
    await expect.poll(() => desktop, { timeout: 15000 }).toContain('DORMINDO_AGORA')
    // Ctrl+C fica no ⋯, que abre a segunda linha de teclas.
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click()
    await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click()
    // O Windows descarta a entrada pendente no ^C: o próximo comando só depois do prompt voltar.
    await expect.poll(() => desktop.split('DORMINDO_AGORA').at(-1), { timeout: 15000 }).toMatch(/PS [^\r\n]*>/)
    terminals.write(tab.id, "Write-Output ('DEPOIS_' + 'DO_CTRLC')\r")
    await expect.poll(() => desktop, { timeout: 15000 }).toContain('DEPOIS_DO_CTRLC')
    expect(desktop).not.toContain('NAO_TERMINOU')
    expect(terminals.pids().get(tab.id)).toBe(pid)

    // Print do celular: vira arquivo no PC e o caminho vai junto com a mensagem, como o Ctrl+V com imagem no PC.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    // Sem rede nenhuma, o aviso aparece no campo de mensagem, onde a pessoa agiu, e não no topo do app.
    await page.route('**/api/image', (route) => route.abort('connectionreset'))
    await page.getByLabel('Escolher imagem').setInputFiles({ name: 'print.png', mimeType: 'image/png', buffer: png })
    await browserExpect(page.locator('.composer').getByRole('alert')).toContainText('Não deu para enviar a imagem ao PC')
    await browserExpect(page.locator('.error-banner')).toHaveCount(0)
    await page.unroute('**/api/image')
    // A primeira tentativa cai na rede, como a conexão velha depois da tela apagada: o envio tenta de novo sozinho.
    let dropped = 0
    await page.route('**/api/image', (route) => (dropped++ === 0 ? route.abort('connectionreset') : route.continue()))
    await page.getByLabel('Escolher imagem').setInputFiles({ name: 'print.png', mimeType: 'image/png', buffer: png })
    await browserExpect(page.getByRole('img', { name: 'Imagem anexada' })).toBeVisible()
    expect(dropped).toBe(2)
    await page.unroute('**/api/image')
    await page.getByRole('textbox', { name: 'Mensagem para a sessão' }).fill("Write-Output 'OLHA_O_PRINT'")
    await page.screenshot({ path: join(resolve('e2e/.results/mobile-validation'), 'campo-350.png') })
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect.poll(() => submitted.at(-1)?.text ?? '', { timeout: 10000 }).toBe("Write-Output 'OLHA_O_PRINT'")
    const [attached] = submitted.at(-1)!.images
    expect(attached).toMatch(/\\imagens\\print-\S+\.png$/)
    expect(readFileSync(attached!)).toEqual(png)
    await browserExpect(page.getByRole('img', { name: 'Imagem anexada' })).toHaveCount(0)
    await page.screenshot({ path: join(resolve('e2e/.results/mobile-validation'), 'imagem-350.png') })

    // PC digita: o tamanho vai para a janela e o celular mostra o aviso; tocar nele traz de volta.
    runtime.desktopSize(tab.id, { cols: 140, rows: 40 })
    runtime.desktopTake(tab.id)
    await browserExpect(page.getByRole('button', { name: /Em uso no PC/ })).toBeVisible()
    expect(runtime.sizes.holder(tab.id)).toBe(DESKTOP)
    await page.screenshot({ path: join(artifacts, 'sessao-no-pc-350.png') })
    await page.getByRole('button', { name: /Em uso no PC/ }).click()
    await expect.poll(() => runtime.sizes.holder(tab.id)).toBe(device)
    await browserExpect(page.getByRole('button', { name: /Em uso no PC/ })).toHaveCount(0)

    // Teclado e a fileira do ⋯ são passageiros: o terminal compartilhado (e a janela do PC) fica do mesmo tamanho, e
    // o celular esconde as linhas de cima, não a de baixo, onde está o cursor.
    const steady = runtime.sizes.current(tab.id)
    const lastRowVisible = (): Promise<boolean> => page.evaluate(() => {
      const area = document.querySelector('.terminal-area')!.getBoundingClientRect()
      const rows = document.querySelectorAll('.xterm-rows > div')
      const last = rows[rows.length - 1]!.getBoundingClientRect()
      return last.top >= area.top && last.bottom <= area.bottom + 1
    })
    await page.setViewportSize({ width: 350, height: 420 })
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click()
    await page.waitForTimeout(600)
    expect(runtime.sizes.current(tab.id)).toEqual(steady)
    expect(await lastRowVisible()).toBe(true)
    await page.getByRole('button', { name: 'Mais teclas', exact: true }).click()
    await page.setViewportSize({ width: 350, height: 700 })
    await page.waitForTimeout(600)
    expect(runtime.sizes.current(tab.id)).toEqual(steady)
    // Girar o celular muda a largura: aí o terminal acompanha.
    await page.setViewportSize({ width: 700, height: 350 })
    await expect.poll(() => runtime.sizes.current(tab.id)?.cols).toBeGreaterThan(steady!.cols)
    await page.setViewportSize({ width: 350, height: 700 })

    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(250)
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width)
      await browserExpect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible()
      await browserExpect(page.getByRole('button', { name: 'Mais teclas', exact: true })).toBeVisible()
      await page.screenshot({ path: join(artifacts, `sessao-${width}.png`) })
    }

    // Sair da tela da sessão devolve o tamanho ao PC.
    runtime.desktopSize(tab.id, { cols: 140, rows: 40 })
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await expect.poll(() => runtime.sizes.holder(tab.id)).toBe(DESKTOP)
    await page.goForward()
    await browserExpect(page.locator('.xterm-screen')).toBeVisible()

    await page.setViewportSize({ width: 350, height: 700 })
    await page.getByRole('button', { name: 'Ações da aba', exact: true }).click()
    await page.getByRole('button', { name: 'Suspender sessão', exact: true }).click()
    await browserExpect(page.getByRole('heading', { name: 'Sessão suspensa' })).toBeVisible()
    expect(terminals.pids().has(tab.id)).toBe(false)
    await page.getByRole('button', { name: 'Continuar conversa', exact: true }).click()
    await browserExpect(page.locator('.xterm-screen')).toBeVisible()
    await page.getByRole('button', { name: 'Ações da aba', exact: true }).click()
    await page.getByRole('button', { name: 'Renomear', exact: true }).click()
    await page.getByRole('textbox', { name: 'Nome da aba', exact: true }).fill('Sessão do celular')
    await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
    await browserExpect(page.locator('.session-name')).toHaveText('Sessão do celular')
    await browserExpect(page.getByRole('dialog')).toHaveCount(0)
    await page.reload()
    await browserExpect(page.getByRole('textbox', { name: 'Mensagem para a sessão' })).toBeVisible()
    await page.getByRole('button', { name: 'Ações da aba', exact: true }).click()
    await browserExpect(page.getByRole('dialog')).toBeVisible()
    await page.goBack()
    await browserExpect(page.getByRole('dialog')).toHaveCount(0)
    await page.goBack()
    await browserExpect(page.getByRole('heading', { name: 'Projeto de validação', exact: true })).toBeVisible()
    await page.goBack()
    await browserExpect(page.getByRole('heading', { name: 'Seus projetos' })).toBeVisible()
    await browserExpect(page.locator('.tree-tabs').getByRole('button', { name: /Sessão do celular/ })).toBeVisible()

    // Segurar a aba na lista abre as opções dela sem abrir a sessão.
    const treeTab = page.locator('.tree-tab').filter({ hasText: 'Sessão do celular' })
    // Toque de verdade (não mouse): no celular o dedo solta em cima da folha que acabou de abrir.
    const touch = await context.newCDPSession(page)
    const hold = async (): Promise<void> => {
      const box = (await treeTab.boundingBox())!
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await page.waitForTimeout(700)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(300)
    }
    await hold()
    await browserExpect(page.getByRole('dialog').getByRole('heading', { name: 'Sessão do celular' })).toBeVisible()
    await page.getByRole('button', { name: 'Suspender sessão', exact: true }).click()
    await browserExpect(page.getByRole('dialog')).toHaveCount(0)
    await browserExpect(page.getByRole('heading', { name: 'Seus projetos' })).toBeVisible()
    await browserExpect(treeTab).toContainText('Suspensa')
    expect(terminals.pids().has(tab.id)).toBe(false)
    await hold()
    await page.getByRole('button', { name: 'Continuar sessão', exact: true }).click()
    await browserExpect(treeTab).toContainText('Aberta')
    expect(terminals.pids().has(tab.id)).toBe(true)

    const newFolder = join(dir, 'Novo projeto real')
    mkdirSync(newFolder)
    writeFileSync(join(newFolder, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#d98e3a"/></svg>')
    await page.getByRole('button', { name: 'Novo projeto', exact: true }).first().click()
    await browserExpect(page.getByRole('dialog')).toBeVisible()
    // A listagem inicial (pasta pessoal) sobrescreve o campo quando termina: só digitar depois dela.
    await browserExpect(page.locator('.folder-entries')).toHaveAttribute('aria-busy', 'false')
    await page.getByRole('textbox', { name: 'Caminho no PC', exact: true }).fill(newFolder)
    await page.getByRole('button', { name: 'Abrir caminho', exact: true }).click()
    await browserExpect(page.locator('.folder-selected')).toHaveText(newFolder)
    await page.getByRole('button', { name: 'Adicionar projeto', exact: true }).click()
    await browserExpect(page.getByRole('heading', { name: 'Novo projeto real', exact: true })).toBeVisible()
    expect(runtime.snapshot().projects).toHaveLength(2)
    await browserExpect(page.locator('.project-heading .project-avatar')).toBeVisible()
    await page.goBack()
    await browserExpect(page.getByRole('heading', { name: 'Seus projetos' })).toBeVisible()
    const relocated = join(dir, 'Pasta corrigida')
    await expect.poll(() => { try { renameSync(newFolder, relocated); return true } catch { return false } }, { timeout: 10000 }).toBe(true)
    mobile.publishState()
    await page.getByRole('button', { name: 'Revincular', exact: true }).click()
    await browserExpect(page.locator('.folder-entries')).toHaveAttribute('aria-busy', 'false')
    await page.getByRole('textbox', { name: 'Caminho no PC', exact: true }).fill(relocated)
    await page.getByRole('button', { name: 'Abrir caminho', exact: true }).click()
    await browserExpect(page.locator('.folder-selected')).toHaveText(relocated)
    await page.getByRole('button', { name: 'Revincular pasta', exact: true }).click()
    await browserExpect(page.getByRole('dialog')).toHaveCount(0)
    expect(runtime.snapshot().missingProjectIds).toEqual([])
    expect(runtime.snapshot().projects[1]!.path).toBe(relocated)
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height })
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width)
      await page.screenshot({ path: join(artifacts, `home-${width}.png`) })
    }
    await page.setViewportSize({ width: 350, height: 700 })
    // Reabrir o app com o celular já vinculado vai direto da logo para os projetos, sem passar pela tela de parear.
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (document.querySelector('.pair-card')) Object.assign(window, { __sawPairCard: true })
      }).observe(document, { childList: true, subtree: true })
    })
    await page.reload()
    await browserExpect(page.getByRole('heading', { name: 'Seus projetos' })).toBeVisible()
    expect(await page.evaluate(() => '__sawPairCard' in window)).toBe(false)
    const footer = page.getByRole('button', { name: 'Limites de uso e conta', exact: true })
    await browserExpect(footer).toContainText('91%')
    await footer.click()
    const pc = page.getByRole('dialog')
    await browserExpect(pc.getByText('91% usado', { exact: true })).toBeVisible()
    await pc.getByRole('button', { name: /trabalho@exemplo.com/ }).click()
    await browserExpect(pc.getByRole('button', { name: /trabalho@exemplo.com/ })).toHaveAttribute('aria-pressed', 'true')
    expect(activeAccount).toBe('trabalho')
    await page.goBack()
    await browserExpect(page.getByRole('dialog')).toHaveCount(0)
    // Dentro do app Android a página ganha a ponte KoraApp; aqui ela é simulada com o mesmo contrato.
    await page.evaluate(() => Object.assign(window, { KoraApp: {
      lerQr() {}, escolherPc() { Object.assign(window, { __escolheuPc: true }) }, pronto() {}, versao: () => '0.2.2',
      buscarAtualizacao() { Object.assign(window, { __buscouAtualizacao: true }) }
    } }))
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: /Buscar atualização/ }).click()
    await browserExpect(page.getByRole('dialog').getByRole('button', { name: /Buscar atualização/ })).toContainText('Versão 0.2.2')
    expect(await page.evaluate(() => '__buscouAtualizacao' in window)).toBe(true)
    await pc.getByRole('button', { name: 'Trocar de PC', exact: true }).click()
    expect(await page.evaluate(() => '__escolheuPc' in window)).toBe(true)
    await pc.getByRole('switch', { name: 'Som', exact: true }).click()
    await browserExpect(pc.getByRole('switch', { name: 'Som', exact: true })).toHaveAttribute('aria-checked', 'false')
    expect(state.settings.alerts).toEqual({ sound: false, windowsNotification: true })
    await pc.getByRole('button', { name: /Renomear$/ }).click()
    await pc.getByRole('textbox', { name: 'Nome deste celular', exact: true }).fill('Galaxy da validação')
    await pc.getByRole('button', { name: 'Salvar', exact: true }).click()
    await browserExpect(pc.getByRole('button', { name: /Galaxy da validação/ })).toBeVisible()
    expect(mobile.status().devices.find((d) => d.id === device)?.name).toBe('Galaxy da validação')
    // O tema do celular fica nas configurações, em Aparência.
    const themes = pc.getByRole('group', { name: 'Tema do celular' })
    await themes.getByRole('button', { name: 'Claro', exact: true }).click()
    await browserExpect(themes.getByRole('button', { name: 'Claro', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false)
    await themes.getByRole('button', { name: 'Escuro', exact: true }).click()
    // O celular de teste está no tema escuro: só o botão marcado distingue Escuro de Sistema.
    await browserExpect(themes.getByRole('button', { name: 'Escuro', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    const pcSize = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    expect(pcSize.scroll).toBeLessThanOrEqual(pcSize.width)
    await page.screenshot({ path: join(artifacts, 'pc-350.png') })
    await page.goBack()
    await page.screenshot({ path: join(artifacts, 'home-rodape-350.png') })
    await page.goBack()
    await browserExpect(page.getByRole('dialog')).toHaveCount(0)
    await page.locator('.tree-tab').filter({ hasText: 'Sessão do celular' }).click()
    await browserExpect(page.locator('.xterm-screen')).toBeVisible()
    await page.getByRole('button', { name: 'Ações da aba', exact: true }).click()
    await page.getByRole('button', { name: 'Fechar aba', exact: true }).click()
    await browserExpect(page.getByText('Fechar esta aba? A conversa salva continua no PC.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Fechar aba', exact: true }).click()
    await browserExpect(page.getByRole('heading', { name: 'Projeto de validação', exact: true })).toBeVisible()
    expect(runtime.snapshot().tabs).toHaveLength(0)
    expect(terminals.pids().has(tab.id)).toBe(false)

    // O Codex rola o histórico ele mesmo, na tela alternativa, pela roda do mouse: o dedo arrastado vira a roda.
    await page.getByRole('button', { name: 'Nova aba', exact: true }).click()
    await page.getByRole('dialog').locator('.new-tab-option').filter({ hasText: /^Codex/ }).click()
    await browserExpect(page.locator('.xterm-screen')).toBeVisible()
    await expect.poll(() => desktop, { timeout: 15000 }).toContain('TELA_CHEIA')
    const codexTab = runtime.snapshot().tabs.at(-1)!
    const finger = await context.newCDPSession(page)
    const area = (await page.locator('.terminal-mount').boundingBox())!
    const drag = async (from: number, to: number): Promise<void> => {
      const x = area.x + area.width / 2
      await finger.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] })
      for (let i = 1; i <= 8; i++) await finger.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + ((to - from) * i) / 8 }] })
      await finger.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    const wheel = (button: number): boolean => written.some((w) => w.id === codexTab.id && w.data.includes(`\x1b[<${button};`))
    await drag(area.y + 40, area.y + 200)
    await expect.poll(() => wheel(64), { timeout: 10000 }).toBe(true)
    expect(wheel(65)).toBe(false)
    await drag(area.y + 200, area.y + 40)
    await expect.poll(() => wheel(65), { timeout: 10000 }).toBe(true)

    // Arquivos do projeto: ver e editar Markdown, ver HTML com o CSS dele, PDF e imagem, como no explorador do PC.
    mkdirSync(join(dir, 'docs'))
    const note = join(dir, 'docs', 'nota.md')
    writeFileSync(note, '# Título da nota\r\nlinha do PC\r\n')
    writeFileSync(join(dir, 'docs', 'pagina.html'), '<link rel="stylesheet" href="estilo.css"><h1>Página de teste</h1>')
    writeFileSync(join(dir, 'docs', 'estilo.css'), 'h1 { color: rgb(255, 0, 0) }')
    writeFileSync(join(dir, 'docs', 'foto.png'), png)
    writeFileSync(join(dir, 'docs', 'doc.pdf'), [
      '%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<<>>>>endobj',
      '4 0 obj<</Length 11>>stream', '0 0 m 9 9 l', 'endstream endobj', 'trailer<</Root 1 0 R>>', '%%EOF'
    ].join('\n'))
    // Do chat, os arquivos do projeto estão na barra da sessão, ao lado dos ajustes da aba.
    await page.locator('.session-strip').getByRole('button', { name: 'Arquivos do projeto', exact: true }).click()
    await page.locator('.file-row').filter({ hasText: /^docs$/ }).click()
    await page.locator('.file-row').filter({ hasText: 'nota.md' }).click()
    await browserExpect(page.locator('.markdown-view h1')).toHaveText('Título da nota')
    await page.screenshot({ path: join(artifacts, 'arquivo-md-350.png') })
    await page.getByRole('button', { name: 'Editar', exact: true }).click()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('linha do celular')
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await browserExpect(page.locator('.file-notice[role="status"]')).toContainText('Salvo no PC.')
    expect(readFileSync(note, 'utf8')).toBe('# Título da nota\r\nlinha do PC\r\nlinha do celular')
    // O agente muda o arquivo com ele aberto no celular: salvar avisa em vez de apagar o que o agente escreveu.
    writeFileSync(note, 'o agente escreveu isto')
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('!')
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await browserExpect(page.locator('.file-notice[role="alert"]')).toContainText('mudou no PC depois que você abriu')
    expect(readFileSync(note, 'utf8')).toBe('o agente escreveu isto')
    await page.screenshot({ path: join(artifacts, 'arquivo-conflito-350.png') })
    await page.getByRole('button', { name: 'Salvar por cima', exact: true }).click()
    await browserExpect(page.locator('.file-notice[role="status"]')).toContainText('Salvo no PC.')
    expect(readFileSync(note, 'utf8')).toBe('# Título da nota\r\nlinha do PC\r\nlinha do celular!')
    // Sai sem salvar, o agente muda o arquivo, e ao voltar o rascunho volta avisando do conflito antes de salvar.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' rascunho')
    await page.goBack()
    writeFileSync(note, 'o agente mudou de novo')
    await page.locator('.file-row').filter({ hasText: 'nota.md' }).click()
    await browserExpect(page.locator('.file-notice[role="alert"]')).toContainText('mudou no PC depois delas')
    await page.getByRole('button', { name: 'Recarregar do PC', exact: true }).click()
    await browserExpect(page.locator('.markdown-view, .cm-content').first()).toContainText('o agente mudou de novo')
    expect(readFileSync(note, 'utf8')).toBe('o agente mudou de novo')
    // Editar → Ver → Editar continua com o que foi digitado, em vez de voltar ao texto de quando abriu.
    await page.getByRole('button', { name: 'Editar', exact: true }).click()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' A')
    await page.getByRole('button', { name: 'Ver', exact: true }).click()
    await page.getByRole('button', { name: 'Editar', exact: true }).click()
    await browserExpect(page.locator('.cm-content')).toContainText('o agente mudou de novo A')
    // Digitar enquanto o PC responde ao salvar: o que veio depois continua sem salvar, e não some.
    await page.route('**/api/file', async (route) => {
      if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 800))
      await route.continue()
    })
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' B')
    await browserExpect(page.locator('.file-notice[role="status"]')).toContainText('Salvo no PC.')
    await page.unroute('**/api/file')
    expect(readFileSync(note, 'utf8')).toBe('o agente mudou de novo A')
    await browserExpect(page.getByRole('button', { name: 'Salvar', exact: true })).toBeVisible()
    await browserExpect(page.locator('.cm-content')).toContainText('o agente mudou de novo A B')
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect.poll(() => readFileSync(note, 'utf8')).toBe('o agente mudou de novo A B')
    await page.goBack()
    await page.locator('.file-row').filter({ hasText: 'pagina.html' }).click()
    const frame = page.frameLocator('iframe.html-view')
    await browserExpect(frame.locator('h1')).toHaveText('Página de teste')
    await browserExpect(frame.locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)')
    await page.goBack()
    await page.locator('.file-row').filter({ hasText: 'doc.pdf' }).click()
    // A página é desenhada de verdade (o canvas ganha pixels) e o zoom dos botões muda o tamanho dela.
    const pdfPage = page.getByLabel('Página 1', { exact: true })
    await expect.poll(() => pdfPage.evaluate((canvas: HTMLCanvasElement) => canvas.width), { timeout: 15000 }).toBeGreaterThan(0)
    const fitWidth = (await pdfPage.boundingBox())!.width
    const percent = page.getByRole('button', { name: 'Ajustar à tela', exact: true })
    const fitPercent = await percent.textContent()
    await page.getByRole('button', { name: 'Ampliar', exact: true }).click()
    await expect.poll(async () => (await pdfPage.boundingBox())!.width).toBeGreaterThan(fitWidth * 1.2)
    await browserExpect(percent).not.toHaveText(fitPercent ?? '')
    await percent.click()
    await expect.poll(async () => Math.round((await pdfPage.boundingBox())!.width)).toBe(Math.round(fitWidth))
    await page.screenshot({ path: join(artifacts, 'arquivo-pdf-350.png') })
    await page.goBack()
    // Link de um Markdown para outro arquivo do projeto abre o arquivo no Kora.
    writeFileSync(join(dir, 'docs', 'indice.md'), '# Índice\n\nVeja a [outra nota](outra.md).\n')
    writeFileSync(join(dir, 'docs', 'outra.md'), '# Outra nota\n')
    await page.getByRole('button', { name: 'Atualizar arquivos', exact: true }).click()
    await page.locator('.file-row').filter({ hasText: 'indice.md' }).click()
    await page.getByRole('link', { name: 'outra nota', exact: true }).click()
    await browserExpect(page.locator('.markdown-view h1')).toHaveText('Outra nota')
    await page.goBack()
    await page.goBack()
    await page.locator('.file-row').filter({ hasText: 'foto.png' }).click()
    await expect.poll(() => page.locator('.image-view img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
    const fileSize = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    expect(fileSize.scroll).toBeLessThanOrEqual(fileSize.width)
    // Da lista inicial, os arquivos do projeto estão a um toque, sem passar pela página de conversas.
    await page.getByRole('button', { name: 'Início', exact: true }).click()
    await page.getByRole('button', { name: 'Arquivos de Projeto de validação', exact: true }).click()
    await browserExpect(page.locator('.file-row').filter({ hasText: /^docs$/ })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    process.env['PATH'] = originalPath
    await browser.close()
    await mobile.stop()
    terminals.killAll()
    await vite.close()
  }
}, 120000)
