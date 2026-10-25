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
  const vite = await createServer({ configFile: false, root: resolve('src/renderer'), cacheDir: join(dir, 'vite-cache'), plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0, hmr: false }, resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } } })
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
    await browserExpect(page.getByRole('button', { name: 'Vincular celular' })).toBeVisible({ timeout: 15000 })
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

    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(250)
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width)
      await browserExpect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible()
      await browserExpect(page.getByRole('button', { name: 'Ctrl+C', exact: true })).toBeVisible()
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
    await page.evaluate(() => Object.assign(window, { KoraApp: { lerQr() {}, escolherPc() {}, pronto() {}, versao: () => '0.2.2', buscarAtualizacao() { Object.assign(window, { __buscouAtualizacao: true }) } } }))
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: /Buscar atualização/ }).click()
    await browserExpect(page.getByRole('dialog').getByRole('button', { name: /Buscar atualização/ })).toContainText('Versão 0.2.2')
    expect(await page.evaluate(() => '__buscouAtualizacao' in window)).toBe(true)
    await pc.getByRole('switch', { name: 'Som', exact: true }).click()
    await browserExpect(pc.getByRole('switch', { name: 'Som', exact: true })).toHaveAttribute('aria-checked', 'false')
    expect(state.settings.alerts).toEqual({ sound: false, windowsNotification: true })
    await pc.getByRole('button', { name: /Renomear/ }).click()
    await pc.getByRole('textbox', { name: 'Nome deste celular', exact: true }).fill('Galaxy da validação')
    await pc.getByRole('button', { name: 'Salvar', exact: true }).click()
    await browserExpect(pc.getByRole('button', { name: /Galaxy da validação/ })).toBeVisible()
    expect(mobile.status().devices.find((d) => d.id === device)?.name).toBe('Galaxy da validação')
    const pcSize = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    expect(pcSize.scroll).toBeLessThanOrEqual(pcSize.width)
    await page.screenshot({ path: join(artifacts, 'pc-350.png') })
    await page.goBack()
    await page.getByRole('button', { name: /^Tema:/ }).click()
    await browserExpect(page.getByRole('button', { name: /^Tema:/ })).toHaveAccessibleName('Tema: Claro')
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false)
    await page.screenshot({ path: join(artifacts, 'home-claro-350.png') })
    await page.getByRole('button', { name: /^Tema:/ }).click()
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
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
    expect(errors).toEqual([])
  } finally {
    process.env['PATH'] = originalPath
    await browser.close()
    await mobile.stop()
    terminals.killAll()
    await vite.close()
  }
}, 120000)
