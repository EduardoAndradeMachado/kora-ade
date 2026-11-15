import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CDPSession, Page } from '@playwright/test'
import { test, expect } from './harness'
import { MOBILE_PORT, newTab, pdfBytes, readClipboardText, readState, restoreClipboard, saveClipboard, starts, typeLine, ui, waitFor, writeState, type KoraRun, type SavedState } from './kora'

// O celular de verdade é uma página no navegador; aqui ele é a mesma API HTTP, chamada direto pelo teste.
const BASE = `http://127.0.0.1:${MOBILE_PORT}`

interface PhoneTab { id: string; title: string; live: boolean; holder: string | null }

async function pairPhone(run: KoraRun): Promise<{ cookie: string; device: string }> {
  const status = await run.page.evaluate(() => window.kora.setMobileEnabled(true))
  expect(status.enabled).toBe(true)
  const pairing = await run.page.evaluate(() => window.kora.pairMobile())
  const code = new URL(pairing.url).hash.replace('#pair=', '')
  const paired = await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Celular e2e' }) })
  expect(paired.status).toBe(200)
  const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
  const { deviceId } = await (await fetch(`${BASE}/api/state`, { headers: { cookie } })).json()
  return { cookie, device: deviceId }
}

async function until<T>(fn: () => Promise<T | undefined | false>, message: string): Promise<T> {
  let value: T | undefined | false
  await expect.poll(async () => Boolean((value = await fn().catch(() => undefined))), { message, timeout: 30_000 }).toBe(true)
  return value as T
}

async function phoneTabs(cookie: string): Promise<PhoneTab[]> {
  return (await (await fetch(`${BASE}/api/state`, { headers: { cookie } })).json()).state.tabs
}

async function phone(cookie: string, command: Record<string, unknown>): Promise<{ tabId?: string }> {
  const response = await fetch(`${BASE}/api/action`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(command) })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body
}

async function screen(cookie: string, tabId: string): Promise<string> {
  return (await (await fetch(`${BASE}/api/snapshot?tab=${tabId}`, { headers: { cookie } })).json())?.data ?? ''
}

test('R-celular aba do PC compartilhada: celular assume o tamanho, PC volta ao digitar e os dois escrevem no mesmo shell', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await newTab(run.page, 'Terminal')
  await expect(ui.terminal(run.page)).toBeVisible()
  const { cookie, device } = await pairPhone(run)
  const tab = await until(async () => (await phoneTabs(cookie)).find((t) => t.live), 'aba do PC viva para o celular')
  const banner = run.page.getByRole('button', { name: /Em uso no celular/ })

  await phone(cookie, { type: 'attach', tabId: tab.id, cols: 50, rows: 20 })
  await expect(banner).toBeVisible()
  await expect(run.page.getByText('Celular e2e', { exact: true })).toBeVisible()
  expect((await phoneTabs(cookie)).find((t) => t.id === tab.id)!.holder).toBe(device)

  await phone(cookie, { type: 'send', tabId: tab.id, text: "Write-Output ('VEIO_DO_' + 'CELULAR')" })
  await until(async () => (await screen(cookie, tab.id)).includes('VEIO_DO_CELULAR'), 'saída do comando do celular')
  await run.page.screenshot({ path: 'e2e/.results/celular-no-pc.png' })

  await typeLine(run.page, "Write-Output ('VEIO_DO_' + 'PC')")
  await expect(banner).toHaveCount(0)
  await until(async () => (await screen(cookie, tab.id)).includes('VEIO_DO_PC'), 'saída do comando digitado no PC')
  expect((await phoneTabs(cookie)).find((t) => t.id === tab.id)!.holder).toBe('desktop')

  await phone(cookie, { type: 'keys', tabId: tab.id, data: '\x1b' })
  await expect(banner).toBeVisible()
  await phone(cookie, { type: 'detach', tabId: tab.id })
  await expect(banner).toHaveCount(0)
})

test('R-celular aba aberta, renomeada e fechada pelo celular aparece e some na janela do PC', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)

  const { tabId } = await phone(cookie, { type: 'create', projectId: 'p1', kind: 'shell', cols: 60, rows: 30 })
  await expect(ui.barTab(run.page, 'Terminal')).toBeVisible()
  await ui.barTab(run.page, 'Terminal').click()
  await expect(ui.terminal(run.page)).toBeVisible()
  await expect(ui.visibleButton(run.page, 'Abrir terminal')).toHaveCount(0)
  await phone(cookie, { type: 'send', tabId, text: "Write-Output ('ABA_DO_' + 'CELULAR')" })
  await until(async () => (await screen(cookie, tabId!)).includes('ABA_DO_CELULAR'), 'saída na aba aberta pelo celular')

  await phone(cookie, { type: 'rename', tabId, title: 'Renomeada no celular' })
  await expect(ui.barTab(run.page, 'Renomeada no celular')).toBeVisible()
  await waitFor(() => readState(env).tabs.find((t) => t.id === tabId)?.title === 'Renomeada no celular', 'nome salvo')

  await phone(cookie, { type: 'close', tabId })
  await expect(ui.barTab(run.page, 'Renomeada no celular')).toHaveCount(0)
  await waitFor(() => readState(env).tabs.length === 0, 'aba fechada no estado salvo')
})

test('R-celular painel do celular: abre pelo rodapé, mostra o caminho ligado e o celular conectado, e conecta outro', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  // O celular com o Kora aberto: o fluxo de eventos mantém ele "conectado agora".
  const events = new AbortController()
  void fetch(`${BASE}/api/events`, { headers: { cookie }, signal: events.signal }).catch(() => {})
  try {
    const button = run.page.getByRole('button', { name: 'Celular', exact: true })
    await button.click()
    const panel = run.page.getByRole('dialog', { name: 'Celular' })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('switch', { name: 'Rede de casa' })).toHaveAttribute('aria-checked', 'true')
    await expect(panel.getByRole('switch', { name: 'Fora de casa' })).toHaveAttribute('aria-checked', 'false')
    await expect(panel.getByText('Celular e2e', { exact: true })).toBeVisible()
    await expect(panel.getByText('Conectado agora, pela rede de casa')).toBeVisible()
    await panel.getByRole('button', { name: 'Conectar celular' }).click()
    await expect(panel.getByRole('img', { name: 'QR code da nova conexão' })).toBeVisible()
    await expect(panel.getByRole('timer')).toContainText('Expira em')
    await run.page.screenshot({ path: 'e2e/.results/celular-painel.png' })
    await run.page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  } finally {
    events.abort()
  }
})

test('R-celular-sino sessão que para com o app do celular aberto: sininho no lugar do modelo e som da corda; abrir limpa; som desliga só no celular', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  await newTab(run.page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')
  await waitFor(() => readState(env).tabs.some((tab) => tab.agent?.kind === 'claude'), 'aba do Claude no estado salvo')

  // O celular é a página servida pelo PC, numa janela à parte com o cookie do pareamento.
  const [name, value] = cookie.split('=') as [string, string]
  const opened = run.app.waitForEvent('window')
  await run.app.evaluate(async ({ BrowserWindow, session }, { url, name, value }) => {
    await session.defaultSession.cookies.set({ url, name, value })
    void new BrowserWindow({ width: 400, height: 800 }).loadURL(url)
  }, { url: `${BASE}/`, name, value })
  const phone = await opened
  const row = phone.locator('.tree-tab').filter({ hasText: 'Claude' })
  await expect(row).toBeVisible()
  await phone.evaluate(() => {
    const g = window as unknown as { __chimes: number }
    g.__chimes = 0
    const Audio = window.AudioContext
    window.AudioContext = class extends Audio {
      override createBufferSource(): AudioBufferSourceNode {
        g.__chimes++
        return super.createBufferSource()
      }
    }
  })
  const chimes = (): Promise<number> => phone.evaluate(() => (window as unknown as { __chimes: number }).__chimes)
  // O primeiro toque destrava o áudio, como no app.
  await phone.locator('.section-heading').click()
  const bell = row.locator('[data-icon="sino"]')

  // 7 s de trabalho: bem acima do mínimo de 3 s mesmo com a detecção atrasada pela máquina carregada.
  const work = async (): Promise<void> => {
    await ui.sideTab(run.page, /Claude/).click()
    await typeLine(run.page, 'trabalhe 7')
    await expect(row.locator('small')).toContainText('Trabalhando', { timeout: 10_000 })
  }

  await work()
  await expect(bell).toHaveCount(1, { timeout: 20_000 })
  await expect(row.locator('svg[aria-label="Claude"]'), 'o sininho fica no lugar do modelo').toHaveCount(0)
  await expect(row.locator('small')).toContainText('Esperando você')
  expect(await chimes()).toBe(1)

  await row.click()
  await phone.getByRole('button', { name: 'Voltar' }).first().click()
  await expect(row).toBeVisible()
  await expect(bell, 'abrir a conversa no celular conta como vista').toHaveCount(0)

  await phone.getByRole('button', { name: 'Configurações' }).click()
  const sound = phone.getByRole('region', { name: 'Avisos neste celular' }).getByRole('switch', { name: 'Som' })
  await expect(sound).toHaveAttribute('aria-checked', 'true')
  await sound.click()
  await expect(sound).toHaveAttribute('aria-checked', 'false')
  await phone.getByRole('button', { name: 'Fechar' }).click()
  expect(readState(env).settings?.alerts?.sound, 'o som do PC não muda com o do celular').not.toBe(false)

  await work()
  await expect(bell).toHaveCount(1, { timeout: 20_000 })
  expect(await chimes(), 'som desligado no celular não toca, o sininho continua').toBe(1)
})

// Toque de verdade, pelo mesmo caminho de entrada do navegador: rola o que estiver embaixo do dedo, como no celular.
async function drag(cdp: CDPSession, path: [number, number][]): Promise<void> {
  const [first, ...rest] = path
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first![0], y: first![1] }] })
  let [x, y] = first!
  for (const [nx, ny] of rest) {
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + ((nx - x) * step) / 6, y: y + ((ny - y) * step) / 6 }] })
    }
    ;[x, y] = [nx, ny]
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

// Tela de toque, como no celular: sem ela o xterm não liga a rolagem por arrasto dele (Gesture.isTouchDevice).
async function openPhone(run: KoraRun, cookie: string, size: { width: number; height: number }): Promise<{ phone: Page; cdp: CDPSession }> {
  const [name, value] = cookie.split('=') as [string, string]
  const opened = run.app.waitForEvent('window')
  await run.app.evaluate(async ({ BrowserWindow, session }, { url, name, value, size }) => {
    await session.defaultSession.cookies.set({ url, name, value })
    void new BrowserWindow({ ...size, useContentSize: true }).loadURL(url)
  }, { url: `${BASE}/`, name, value, size })
  const phone = await opened
  const cdp = await phone.context().newCDPSession(phone)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await phone.reload()
  return { phone, cdp }
}

async function tapAt(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('R-celular-gestos arrastar de lado: conversa → arquivos e de volta, conversa → lista, também a partir da borda; vertical, diagonal e área que rola de lado não navegam', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'largo.md'), ['# Largo', '', '```', 'codigo_largo '.repeat(60), '```', ''].join('\n'))
  writeFileSync(join(env.project, 'doc.pdf'), pdfBytes())
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  await newTab(run.page, 'Terminal')
  await waitFor(() => readState(env).tabs.length === 1, 'aba Terminal no estado salvo')

  const { phone, cdp } = await openPhone(run, cookie, { width: 360, height: 720 })
  const { width, height } = await phone.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const middle = Math.round(height / 2)
  const row = phone.locator('.tree-tab').filter({ hasText: 'Terminal' })
  const strip = phone.locator('.session-strip')
  const files = phone.locator('.files-panel')
  const toChat = phone.getByRole('button', { name: 'Voltar à conversa' })
  const left: [number, number][] = [[width - 50, middle], [50, middle]]
  const right: [number, number][] = [[50, middle], [width - 50, middle]]
  // Um gesto que não deve navegar: dá tempo de a tela trocar, se fosse trocar, e confere que ficou.
  const stays = async (path: [number, number][], message: string): Promise<void> => {
    await drag(cdp, path)
    await phone.waitForTimeout(400)
    await expect(strip, message).toBeVisible()
    await expect(files, message).toHaveCount(0)
  }

  await row.click()
  await expect(strip).toBeVisible()
  await expect(phone.locator('.xterm-screen')).toBeVisible()

  await stays([[width / 2, middle - 150], [width / 2, middle + 150]], 'rolar o terminal na vertical não navega')
  await stays([[width - 60, middle - 60], [width - 200, middle + 60]], 'diagonal (140 de lado, 120 para baixo) não navega')
  await stays([[width - 60, middle], [width - 60, middle + 40], [60, middle + 40]], 'começou rolando na vertical: virar de lado depois não navega')
  // Pinça: o segundo dedo chega depois do primeiro, e os dois andam para a esquerda.
  const pinch = async (): Promise<void> => {
    const fingers = (x: number): { x: number; y: number; id: number }[] => [{ x, y: middle - 60, id: 0 }, { x: x - 20, y: middle + 60, id: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [fingers(width - 60)[0]!] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(width - 60) })
    for (let x = width - 90; x >= 60; x -= 30) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(x) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await phone.waitForTimeout(400)
    await expect(strip, 'dois dedos de lado é pinça, não navega').toBeVisible()
    await expect(files).toHaveCount(0)
  }
  await pinch()

  // A partir da borda, onde o dedo costuma começar: com os botões de navegação do Android a borda é da página, e com a
  // navegação por gestos o sistema cancela o toque quando assume o voltar.
  await drag(cdp, [[width - 3, middle], [50, middle]])
  await expect(files, 'conversa: dedo para a esquerda, a partir da borda, abre os arquivos').toBeVisible()
  await expect(toChat).toBeVisible()
  await drag(cdp, [[3, middle], [width - 50, middle]])
  await expect(strip, 'arquivos: dedo para a direita, a partir da borda, volta à conversa').toBeVisible()
  await expect(files).toHaveCount(0)

  await drag(cdp, left)
  await expect(files, 'conversa: dedo para a esquerda abre os arquivos').toBeVisible()
  await expect(toChat).toBeVisible()
  await drag(cdp, right)
  await expect(strip, 'arquivos: dedo para a direita volta à conversa').toBeVisible()
  await expect(files).toHaveCount(0)

  await drag(cdp, left)
  await files.locator('.file-row').filter({ hasText: 'largo.md' }).click()
  const code = phone.locator('.markdown-view pre')
  await expect(code).toBeVisible()
  const box = (await code.boundingBox())!
  const onCode: [number, number][] = [[50, box.y + box.height / 2], [width - 50, box.y + box.height / 2]]
  await code.evaluate((element) => { element.scrollLeft = 300 })
  await drag(cdp, onCode)
  await phone.waitForTimeout(400)
  await expect(code, 'código largo que ainda rola para a esquerda: o arrastar rola, não navega').toBeVisible()
  await code.evaluate((element) => { element.scrollLeft = 0 })
  await drag(cdp, onCode)
  await expect(strip, 'arquivo aberto vindo da conversa: dedo para a direita volta direto à conversa').toBeVisible()
  await expect(code).toHaveCount(0)

  // PDF: toque simples esconde a barra de página e zoom, a faixa do arquivo e o cabeçalho do Kora, e o PDF fica com a
  // tela quase toda; duplo toque é zoom e não esconde nada.
  await drag(cdp, left)
  await files.locator('.file-row').filter({ hasText: 'doc.pdf' }).click()
  const bar = phone.locator('.pdf-zoom')
  const zoom = bar.getByRole('button', { name: 'Ajustar à tela' })
  const header = phone.locator('.file-header')
  await expect(bar, 'o PDF abre com a barra à mostra').toBeVisible()
  await expect(phone.locator('.pdf-page canvas')).toBeVisible()
  const tap = async (times = 1): Promise<void> => {
    const page = (await phone.locator('.pdf-scroller').boundingBox())!
    for (let i = 0; i < times; i++) await tapAt(cdp, page.x + page.width / 2, page.y + page.height / 2)
  }
  const koraHeader = phone.locator('.mobile-header')
  const reading = async (): Promise<number> => (await phone.locator('.pdf-scroller').boundingBox())!.height
  const before = await reading()
  await tap()
  await expect(bar, 'um toque esconde a barra').toBeHidden()
  await expect(header, 'em pé, o toque esconde também a faixa do arquivo').toBeHidden()
  await expect(koraHeader, 'e o cabeçalho do Kora').toBeHidden()
  await expect.poll(async () => (await reading()) / await phone.evaluate(() => innerHeight), { message: 'o PDF fica com a tela quase toda' }).toBeGreaterThan(0.97)
  expect(await reading()).toBeGreaterThan(before)
  await tap()
  await expect(bar, 'outro toque mostra a barra').toBeVisible()
  await expect(header).toBeVisible()
  await expect(koraHeader).toBeVisible()
  const fitted = await zoom.textContent()
  await tap(2)
  await expect(zoom, 'duplo toque amplia').not.toHaveText(fitted!)
  await phone.waitForTimeout(600)
  await expect(bar, 'duplo toque não esconde a barra').toBeVisible()
  await zoom.click()
  await expect(zoom).toHaveText(fitted!)

  const resize = (size: { width: number; height: number }): Promise<void> => run.app.evaluate(({ BrowserWindow }, { base, size }) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith(base))!.setContentSize(size.width, size.height)
  }, { base: BASE, size })
  await resize({ width: 780, height: 360 })
  await expect.poll(() => phone.evaluate(() => window.matchMedia('(orientation: landscape)').matches)).toBe(true)
  await expect(phone.locator('.mobile-header'), 'deitado, o cabeçalho do Kora sai').toBeHidden()
  // Virar o celular é para ver mais da página: deitado, o PDF fica sem a faixa do arquivo e sem a barra, com a
  // página na largura toda.
  await expect(header, 'deitado, o PDF já fica sem a faixa do arquivo').toBeHidden()
  await expect(bar).toBeHidden()
  await expect.poll(async () => (await reading()) / await phone.evaluate(() => innerHeight), { message: 'deitado, o PDF fica com a altura quase toda' }).toBeGreaterThan(0.97)
  const pageWidth = async (): Promise<number> => (await phone.locator('.pdf-page').first().boundingBox())!.width
  const scrollerWidth = async (): Promise<number> => phone.locator('.pdf-scroller').evaluate((element) => element.clientWidth)
  await expect.poll(async () => (await scrollerWidth()) - (await pageWidth()), { message: 'deitado, a página ocupa a largura quase toda' }).toBeLessThan(12)
  // Longe do clique no zoom: dois toques dentro da janela do duplo toque contariam como um duplo.
  await phone.waitForTimeout(600)
  await tap()
  await expect(header, 'deitado, o toque traz a faixa do arquivo de volta').toBeVisible()
  await expect(bar).toBeVisible()
  await phone.waitForTimeout(600)
  await tap()
  await expect(bar).toBeHidden()
  await expect(header).toBeHidden()
  await resize({ width: 360, height: 720 })
  await expect(phone.locator('.mobile-header'), 'em pé, o cabeçalho do Kora volta').toBeVisible()
  await expect(header, 'em pé, a faixa do arquivo volta').toBeVisible()
  await drag(cdp, right)
  await expect(strip).toBeVisible()

  await drag(cdp, right)
  await expect(row, 'conversa: dedo para a direita volta à lista').toBeVisible()
  await expect(strip).toHaveCount(0)
})

test('R-celular-rolagem campo da mensagem focado: arrastar no terminal larga o campo, rola o histórico sem voltar ao fim e o rascunho fica', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  await newTab(run.page, 'Terminal')
  await waitFor(() => readState(env).tabs.length === 1, 'aba Terminal no estado salvo')
  await typeLine(run.page, '1..300 | % { "linha $_" }')

  const { phone, cdp } = await openPhone(run, cookie, { width: 360, height: 720 })
  const width = await phone.evaluate(() => window.innerWidth)
  await phone.locator('.tree-tab').filter({ hasText: 'Terminal' }).click()
  await expect(phone.locator('.xterm-rows')).toContainText('linha 300')
  // Número da primeira linha do histórico à mostra: menor é mais para cima.
  const top = (): Promise<number> => phone.evaluate(() => Number(/linha (\d+)/.exec(document.querySelector('.xterm-rows > div')?.textContent ?? '')?.[1]))
  const field = phone.getByRole('textbox', { name: 'Mensagem para a sessão' })
  const box = (await field.boundingBox())!

  await tapAt(cdp, box.x + 40, box.y + box.height / 2)
  await expect(field).toBeFocused()
  await phone.keyboard.type('rascunho')
  const bottom = await top()
  await drag(cdp, [[width / 2, 150], [width / 2, 450]])
  await expect(field, 'arrastar no terminal larga o campo: o teclado fecha e não puxa a tela de volta').not.toBeFocused()
  expect(await top(), 'o dedo para baixo mostra o histórico de cima').toBeLessThan(bottom)
  // O xterm segue rolando por inércia depois de soltar o dedo; parado, o histórico continua onde ficou.
  await phone.waitForTimeout(1500)
  const settled = await top()
  console.log(`rolagem: fim ${bottom}, depois de assentar ${settled}`)
  await phone.waitForTimeout(1000)
  expect(await top(), 'nada leva de volta ao fim enquanto se lê o histórico').toBe(settled)
  expect(settled).toBeLessThan(bottom)
  await expect(field, 'o rascunho fica').toHaveValue('rascunho')

  await tapAt(cdp, box.x + 40, box.y + box.height / 2)
  await expect(field, 'tocar no campo retoma a digitação').toBeFocused()
  await phone.keyboard.press('End')
  await phone.keyboard.type(' mais')
  await expect(field).toHaveValue('rascunho mais')
})

test('R-celular-bandeja Kora na bandeja segue no ar: a aba continua viva para o celular, que usa o mesmo shell com a janela escondida', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await newTab(run.page, 'Terminal')
  await expect(ui.terminal(run.page)).toBeVisible()
  const { cookie } = await pairPhone(run)
  const tab = await until(async () => (await phoneTabs(cookie)).find((t) => t.live), 'aba viva para o celular')

  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
  expect((await fetch(`${BASE}/health`)).status).toBe(200)
  // Mais que o prazo que o Kora dá para um shell encerrado sair: quem o X tivesse matado já teria sumido.
  await run.page.waitForTimeout(4000)
  expect((await phoneTabs(cookie)).find((t) => t.id === tab.id)?.live, 'o X não suspende a aba').toBe(true)

  await phone(cookie, { type: 'send', tabId: tab.id, text: "Write-Output ('NA_' + 'BANDEJA')" })
  await until(async () => (await screen(cookie, tab.id)).includes('NA_BANDEJA'), 'saída do shell com a janela escondida')
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
})

test('R-celular-markdown Markdown que estoura o desenho no celular: aviso com Voltar e Abrir no editor, e o app segue de pé', async ({ kora }) => {
  const env = kora.env()
  // O lexer do marked é recursivo: citações aninhadas assim estouram a pilha ao desenhar a visualização.
  writeFileSync(join(env.project, 'profundo.md'), `${'>'.repeat(20_000)} x\n`)
  writeFileSync(join(env.project, 'notas.md'), '# Notas do projeto\n')
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 360, height: 720 })

  await phone.getByRole('button', { name: 'Arquivos de proj-teste' }).click()
  await phone.locator('.file-row').filter({ hasText: 'profundo.md' }).click()
  const alert = phone.getByRole('alert').filter({ hasText: 'Não foi possível mostrar este arquivo' })
  await expect(alert).toContainText('Maximum call stack size exceeded')
  await alert.getByRole('button', { name: 'Abrir no editor' }).click()
  await expect(phone.locator('.code-editor')).toBeVisible()
  await expect(alert).toHaveCount(0)

  await phone.getByRole('button', { name: 'Voltar' }).first().click()
  await phone.locator('.file-row').filter({ hasText: 'notas.md' }).click()
  await expect(phone.locator('.markdown-view h1')).toHaveText('Notas do projeto')
})

test('R-celular-organizar projeto movido de categoria pelo celular aparece na categoria da lateral do PC; remover da lista deixa a pasta', async ({ kora }) => {
  const env = kora.env()
  const outro = join(env.root, 'outro')
  mkdirSync(outro)
  writeFileSync(join(outro, 'fica.txt'), 'a pasta não pode sumir')
  writeState(env, {
    version: 2,
    projects: [{ id: 'p1', name: 'proj-teste', path: env.project }, { id: 'p2', name: 'outro', path: outro }],
    tabs: [],
    groups: [{ id: 'g1', name: 'Empresa' }]
  } as SavedState)
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 360, height: 720 })
  const saved = (): SavedState & { projects: { id: string; groupId?: string }[] } => readState(env) as never
  const pcGroup = run.page.locator('[data-group-row]').filter({ hasText: 'Empresa' }).locator('xpath=..')

  // Toque longo no projeto (o menu do sistema chega como contextmenu, igual no Chrome do Android).
  await phone.locator('.tree-project-name').filter({ hasText: 'outro' }).click({ button: 'right' })
  const sheet = phone.getByRole('dialog', { name: 'outro' })
  await sheet.getByRole('button', { name: 'Mover para categoria' }).click()
  await phone.screenshot({ path: 'e2e/.results/celular-mover-categoria.png' })
  await sheet.getByRole('button', { name: 'Empresa' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(phone.getByRole('status').filter({ hasText: 'Projeto movido para Empresa.' })).toBeVisible()
  await waitFor(() => saved().projects.find((p) => p.id === 'p2')?.groupId === 'g1', 'projeto na categoria no estado do PC')
  await expect(pcGroup.locator('[data-project-row]').filter({ hasText: 'outro' })).toBeVisible()
  await expect(phone.locator('.tree-group').filter({ hasText: 'Empresa' }).locator('.tree-project-name').filter({ hasText: 'outro' })).toBeVisible()

  // A categoria nova criada pelo celular também aparece no PC.
  await phone.getByRole('button', { name: 'Nova categoria' }).click()
  await phone.getByLabel('Nome da categoria').fill('Clientes')
  await phone.getByRole('button', { name: 'Criar categoria' }).click()
  await expect(run.page.locator('[data-group-row]').filter({ hasText: 'Clientes' })).toBeVisible()

  await phone.locator('.tree-project-name').filter({ hasText: 'outro' }).click({ button: 'right' })
  await sheet.getByRole('button', { name: 'Remover da lista' }).click()
  await expect(sheet).toContainText('A pasta e os arquivos continuam no PC')
  await phone.screenshot({ path: 'e2e/.results/celular-remover-projeto.png' })
  await sheet.getByRole('button', { name: 'Remover da lista' }).click()
  await expect(run.page.locator('[data-project-row]').filter({ hasText: 'outro' })).toHaveCount(0)
  await waitFor(() => !saved().projects.some((p) => p.id === 'p2'), 'projeto fora do estado do PC')
  expect(existsSync(join(outro, 'fica.txt'))).toBe(true)
})

test('R-celular-arquivos arquivo criado e apagado pelo celular confere no disco, e a lista do celular acompanha o que o PC grava', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 360, height: 720 })
  const row = (name: string) => phone.locator('.file-row').filter({ hasText: name })

  await phone.getByRole('button', { name: 'Arquivos de proj-teste' }).click()
  await phone.getByRole('button', { name: 'Novo arquivo' }).click()
  const field = phone.getByLabel('Nome do arquivo')
  await field.fill('con')
  await expect(phone.getByRole('alert').filter({ hasText: 'nome reservado do Windows' })).toBeVisible()
  await field.fill('docs/nota.md')
  await phone.screenshot({ path: 'e2e/.results/celular-novo-arquivo.png' })
  await phone.getByRole('button', { name: 'Criar arquivo' }).click()
  await waitFor(() => existsSync(join(env.project, 'docs', 'nota.md')), 'arquivo criado no disco do PC')
  await expect(phone.locator('.file-title')).toContainText('nota.md')
  await phone.getByRole('button', { name: 'Voltar' }).first().click()
  await row('docs').click()
  await expect(row('nota.md')).toBeVisible()

  await row('nota.md').click({ button: 'right' })
  const sheet = phone.getByRole('dialog', { name: 'Opções de nota.md' })
  await sheet.getByRole('button', { name: 'Excluir' }).click()
  await expect(sheet).toContainText('Lixeira do Windows')
  await sheet.getByRole('button', { name: 'Mover para a Lixeira' }).click()
  await waitFor(() => !existsSync(join(env.project, 'docs', 'nota.md')), 'arquivo fora do disco do PC')
  await expect(row('nota.md')).toHaveCount(0)

  // Gravado no PC (pelo agente, pelo editor): aparece na pasta aberta no celular sem tocar em atualizar.
  writeFileSync(join(env.project, 'docs', 'do-pc.md'), '# veio do PC\n')
  await expect(row('do-pc.md')).toBeVisible({ timeout: 10_000 })
})

test('R-celular-busca busca sem acento acha pela categoria; copiar caminho fecha a folha com um aviso só; sem conexão a nova aba avisa', async ({ kora }) => {
  const env = kora.env()
  const outro = join(env.root, 'vitrine')
  mkdirSync(outro)
  writeState(env, {
    version: 2,
    projects: [{ id: 'p1', name: 'proj-teste', path: env.project }, { id: 'p2', name: 'vitrine', path: outro, groupId: 'g1' }],
    tabs: [],
    groups: [{ id: 'g1', name: 'Educação' }]
  } as SavedState)
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 350, height: 700 })
  const project = (name: string) => phone.locator('.tree-project-name').filter({ hasText: name })

  // A lupa do cabeçalho leva ao campo; "educacao" acha o projeto da categoria "Educação".
  await phone.getByRole('button', { name: 'Buscar projetos' }).click()
  await expect(phone.getByLabel('Buscar projetos, abas e categorias')).toBeFocused()
  await phone.keyboard.type('EDUCACAO')
  await expect(project('vitrine')).toBeVisible()
  await expect(project('proj-teste')).toHaveCount(0)
  await phone.getByLabel('Buscar projetos, abas e categorias').fill('')

  const saved = await saveClipboard(run)
  try {
    await project('vitrine').click({ button: 'right' })
    await phone.getByRole('dialog', { name: 'vitrine' }).getByRole('button', { name: 'Copiar caminho' }).click()
    await expect(phone.getByRole('dialog')).toHaveCount(0)
    await expect(phone.locator('.mobile-toast')).toHaveText('Caminho copiado.')
    await expect(phone.getByText('Caminho copiado.')).toHaveCount(1)
    expect(await readClipboardText(run)).toBe(outro)
  } finally {
    await restoreClipboard(run, saved)
  }

  // O PC desliga a conexão do celular: a folha de nova aba diz por que as opções não respondem.
  await run.page.evaluate(() => window.kora.setMobileEnabled(false))
  await expect(phone.locator('.connection-dot')).not.toHaveClass(/online/)
  await phone.getByRole('button', { name: 'Nova conversa em proj-teste' }).click()
  const sheet = phone.getByRole('dialog', { name: 'proj-teste' })
  await expect(sheet.getByRole('alert')).toContainText('Sem conexão com o PC')
  await expect(sheet.getByRole('button', { name: /Terminal/ })).toBeDisabled()
  await phone.screenshot({ path: 'e2e/.results/celular-nova-aba-sem-conexao.png' })
})

// A página do projeto tenta de tudo para sair da moldura: ler e mexer na página do Kora, ler o cookie do celular e
// chamar a API do PC. Cada tentativa escreve o resultado na própria página, que o teste lê pela moldura.
const ESCAPE = `<script>
  var alcance = 'bloqueado'
  try { alcance = 'alcançou: ' + parent.document.title; parent.document.body.setAttribute('data-invadido', '1') } catch (e) {}
  document.getElementById('alcance').textContent = alcance
  try { document.getElementById('cookie').textContent = 'cookie: ' + document.cookie } catch (e) { document.getElementById('cookie').textContent = 'cookie bloqueado' }
  fetch('/api/state', { credentials: 'include' }).then(function (r) { document.getElementById('api').textContent = 'api ' + r.status }, function () { document.getElementById('api').textContent = 'api bloqueada' })
</script>`
const page = (title: string): string => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="estilo.css"></head><body><h1 id="titulo">${title}</h1><p id="alcance">?</p><p id="cookie">?</p><p id="api">?</p>${ESCAPE}</body></html>`

test('R-celular-html HTML do projeto abre desenhado e isolado: o script roda só na moldura, sem alcançar a página, o cookie nem a API do Kora; e acompanha o PC', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'site'))
  writeFileSync(join(env.project, 'site', 'estilo.css'), 'h1 { color: rgb(1, 2, 3); }')
  writeFileSync(join(env.project, 'site', 'pagina.html'), page('Página do projeto'))
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 360, height: 720 })
  const row = (name: string) => phone.locator('.file-row').filter({ hasText: name })

  await phone.getByRole('button', { name: 'Arquivos de proj-teste' }).click()
  await row('site').click()
  await row('pagina.html').click()
  const frame = phone.frameLocator('iframe.html-view')
  await expect(frame.locator('#titulo')).toHaveText('Página do projeto')
  await expect(frame.locator('#titulo'), 'o CSS ao lado do HTML vem pelo link de leitura').toHaveCSS('color', 'rgb(1, 2, 3)')
  await expect(frame.locator('#alcance'), 'o script não lê a página do Kora').toHaveText('bloqueado')
  await expect(frame.locator('#cookie'), 'nem o cookie do pareamento').toHaveText(/^(cookie bloqueado|cookie: )$/)
  await expect(frame.locator('#api'), 'nem chega à API do PC').toHaveText(/^api (bloqueada|401|403)$/)
  expect(await phone.evaluate(() => document.body.dataset['invadido']), 'a página do Kora fica intacta').toBeUndefined()
  await phone.screenshot({ path: 'e2e/.results/celular-html.png' })

  // O agente regrava a página com ela aberta e sem nada por salvar no celular: a moldura mostra a versão nova sozinha.
  writeFileSync(join(env.project, 'site', 'pagina.html'), page('Versão nova do agente'))
  await expect(frame.locator('#titulo')).toHaveText('Versão nova do agente', { timeout: 10_000 })
  await expect(phone.getByRole('status').filter({ hasText: 'Atualizado com a versão do PC' })).toBeVisible()
  await expect(frame.locator('#alcance')).toHaveText('bloqueado')
})

test('R-celular-planilha CSV abre como planilha: cabeçalho e número da linha presos ao rolar nos dois sentidos, e busca sem acento', async ({ kora }) => {
  const env = kora.env()
  const header = ['Código', 'Produto', 'Descrição', 'Preço', 'Estoque', 'Fornecedor', 'Cidade', 'Observação']
  const rows = Array.from({ length: 400 }, (_, i) => [String(i + 1), i === 249 ? 'Maçã Fuji' : `Produto ${i + 1}`, 'descrição bem comprida '.repeat(3), `${i + 1},50`, String(i * 3), `Fornecedor ${i % 7}`, 'São Paulo', 'nada'])
  writeFileSync(join(env.project, 'dados.csv'), [header, ...rows].map((r) => r.join(';')).join('\r\n'))
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 360, height: 720 })

  await phone.getByRole('button', { name: 'Arquivos de proj-teste' }).click()
  await phone.locator('.file-row').filter({ hasText: 'dados.csv' }).click()
  const grid = phone.getByRole('grid', { name: 'Planilha' })
  const head = grid.locator('.sheet-head')
  await expect(head.getByRole('columnheader', { name: 'Produto' }), 'o ; do CSV brasileiro é detectado e a 1ª linha vira cabeçalho').toBeVisible()
  await expect(phone.locator('.sheet-count')).toHaveText('400 linhas')
  await grid.evaluate((element) => { element.scrollTop = 4000; element.scrollLeft = 400 })
  await expect(grid.getByRole('rowheader').filter({ hasText: /^130$/ })).toBeVisible()
  const gridBox = (await grid.boundingBox())!
  expect((await head.boundingBox())!.y, 'o cabeçalho fica no alto da grade ao rolar para baixo').toBeCloseTo(gridBox.y, 0)
  expect((await grid.getByRole('rowheader').filter({ hasText: /^130$/ }).boundingBox())!.x, 'o número da linha fica na borda da grade ao rolar de lado').toBeCloseTo(gridBox.x, 0)
  expect(await grid.evaluate((element) => element.scrollLeft), 'a grade rola de lado').toBeGreaterThan(300)
  await phone.screenshot({ path: 'e2e/.results/celular-planilha.png' })

  await phone.getByRole('textbox', { name: 'Buscar na planilha' }).fill('maca')
  await expect(phone.locator('.sheet-count'), 'a busca ignora acento e caixa').toHaveText('1 de 400')
  await expect(grid.getByRole('gridcell', { name: 'Maçã Fuji' })).toBeVisible()
  await expect(grid.getByRole('rowheader')).toHaveText(['251'])
  await grid.getByRole('gridcell', { name: 'Maçã Fuji' }).click()
  await expect(phone.locator('.sheet-cell-bar')).toContainText('B251')
  await expect(phone.locator('.sheet-cell-bar')).toContainText('Maçã Fuji')
})

test('R-celular-mudou-no-pc arquivo aberto acompanha o PC: sem rascunho recarrega sozinho; com rascunho avisa na hora, compara e só descarta ou grava por cima confirmando; apagado no PC avisa', async ({ kora }) => {
  const env = kora.env()
  const file = join(env.project, 'notas.txt')
  writeFileSync(file, 'linha 1\nlinha 2\nlinha 3\n')
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 360, height: 720 })
  const content = phone.locator('.cm-content')
  const conflict = phone.getByRole('alert').filter({ hasText: 'O arquivo mudou no PC enquanto você editava' })
  const save = phone.getByRole('button', { name: 'Salvar', exact: true })
  const type = async (text: string): Promise<void> => {
    await content.click()
    await phone.keyboard.press('Control+End')
    await phone.keyboard.type(text)
  }

  await phone.getByRole('button', { name: 'Arquivos de proj-teste' }).click()
  await phone.locator('.file-row').filter({ hasText: 'notas.txt' }).click()
  await expect(content).toContainText('linha 2')
  await expect(content, 'código abre em Ver: sem campo editável, o toque não abre o teclado').toHaveAttribute('contenteditable', 'false')

  writeFileSync(file, 'linha 1\nlinha 2 do agente\nlinha 3\n')
  await expect(content, 'sem rascunho, a versão do PC vem sozinha').toContainText('linha 2 do agente', { timeout: 10_000 })
  await expect(phone.getByRole('status').filter({ hasText: 'Atualizado com a versão do PC' })).toBeVisible()

  await phone.getByRole('button', { name: 'Editar', exact: true }).click()
  await expect(content).toHaveAttribute('contenteditable', 'true')
  await type('minha linha')
  await expect(save).toBeVisible()
  writeFileSync(file, 'linha 1\nlinha 2 do agente de novo\nlinha 3\n')
  await expect(conflict, 'com rascunho, o aviso vem na hora, sem esperar o Salvar').toBeVisible({ timeout: 10_000 })
  await expect(content, 'o rascunho fica na tela').toContainText('minha linha')

  await conflict.getByRole('button', { name: 'Comparar' }).click()
  const diff = phone.getByRole('region', { name: 'Comparação com o PC' })
  await expect(diff.locator('.diff-line.removed')).toContainText(['linha 2 do agente de novo'])
  await expect(diff.locator('.diff-line.added')).toContainText(['linha 2 do agente', 'minha linha'])
  await phone.screenshot({ path: 'e2e/.results/celular-comparar.png' })
  await diff.getByRole('button', { name: 'Fechar comparação' }).click()
  await expect(diff).toHaveCount(0)

  await conflict.getByRole('button', { name: 'Salvar por cima' }).click()
  await expect(phone.getByRole('alert')).toContainText('Gravar a sua versão por cima')
  await phone.waitForTimeout(300)
  expect(readFileSync(file, 'utf8'), 'nada é gravado antes de confirmar').toBe('linha 1\nlinha 2 do agente de novo\nlinha 3\n')
  await phone.getByRole('button', { name: 'Confirmar e salvar' }).click()
  await waitFor(() => readFileSync(file, 'utf8') === 'linha 1\nlinha 2 do agente\nlinha 3\nminha linha', 'rascunho gravado por cima no PC')
  await expect(save).toHaveCount(0)

  await type(' e mais')
  writeFileSync(file, 'versão final do PC\n')
  await expect(conflict).toBeVisible({ timeout: 10_000 })
  await conflict.getByRole('button', { name: 'Recarregar do PC' }).click()
  await phone.getByRole('button', { name: 'Cancelar' }).click()
  await expect(content, 'cancelar não descarta nada').toContainText('minha linha e mais')
  await conflict.getByRole('button', { name: 'Recarregar do PC' }).click()
  await phone.getByRole('button', { name: 'Descartar e recarregar' }).click()
  await expect(content).toContainText('versão final do PC')
  await expect(content).not.toContainText('minha linha')
  await expect(save).toHaveCount(0)
  expect(readFileSync(file, 'utf8')).toBe('versão final do PC\n')

  rmSync(file)
  await expect(phone.getByRole('alert').filter({ hasText: 'apagado ou renomeado no PC' })).toBeVisible({ timeout: 10_000 })
  await expect(content, 'o que estava na tela fica').toContainText('versão final do PC')
})

// O toque em `arquivo:42` no terminal entra no histórico do celular como a rota do arquivo com a linha (fileLine);
// aqui a rota entra pelo mesmo caminho (pushState + popstate do useMobileNavigation), sem depender do toque no terminal.
async function openAtLine(phone: Page, file: string, line: number): Promise<void> {
  await phone.evaluate(({ file, line }) => {
    const current = history.state.koraMobile
    history.pushState({ koraMobile: { route: { ...current.route, file, fileLine: line }, depth: current.depth + 1 } }, '', location.pathname)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, { file, line })
}

test('R-celular-linha arquivo:linha do terminal abre na linha: código rola e destaca a linha, Markdown vai ao bloco dela, CSV à linha da planilha', async ({ kora }) => {
  const env = kora.env()
  writeFileSync(join(env.project, 'longo.ts'), Array.from({ length: 300 }, (_, i) => `const linha${i + 1} = ${i + 1}`).join('\n'))
  writeFileSync(join(env.project, 'guia.md'), Array.from({ length: 60 }, (_, i) => `## Seção ${i + 1}\n\nTexto da seção ${i + 1}.\n`).join('\n'))
  writeFileSync(join(env.project, 'tabela.csv'), ['nome,valor', ...Array.from({ length: 500 }, (_, i) => `item ${i + 1},${i}`)].join('\n'))
  const run = await kora.launch(env)
  const { cookie } = await pairPhone(run)
  const { phone } = await openPhone(run, cookie, { width: 360, height: 720 })
  await phone.getByRole('button', { name: 'Arquivos de proj-teste' }).click()
  await expect(phone.locator('.file-row').first()).toBeVisible()
  const inView = async (selector: string): Promise<boolean> => phone.locator(selector).first().evaluate((element) => {
    const box = element.getBoundingClientRect()
    return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight
  })

  await openAtLine(phone, 'longo.ts', 240)
  const jumped = phone.locator('.cm-jump-line')
  await expect(jumped, 'a linha pedida fica destacada').toHaveText('const linha240 = 240')
  expect(await inView('.cm-jump-line'), 'e rolada até a tela').toBe(true)
  await expect(phone.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')

  await phone.goBack()
  // Cada seção ocupa 4 linhas (título, vazia, texto, vazia): a 201 é "## Seção 51", a 202 a vazia depois dele e a
  // 203 o texto. Linha que não começa bloco cai no bloco de antes dela.
  await openAtLine(phone, 'guia.md', 202)
  const block = phone.locator('.markdown-view .md-jumped')
  await expect(block, 'Markdown: o bloco onde a linha cai').toHaveText('Seção 51')
  expect(await inView('.markdown-view .md-jumped')).toBe(true)

  await phone.goBack()
  await openAtLine(phone, 'tabela.csv', 400)
  const row = phone.locator('.sheet-row.jumped')
  await expect(row.getByRole('rowheader'), 'CSV: a linha 400 do arquivo é a linha 400 da planilha').toHaveText('400')
  await expect(row.getByRole('gridcell').first()).toHaveText('item 399')
  expect(await inView('.sheet-row.jumped')).toBe(true)
})
