import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CDPSession, Page } from '@playwright/test'
import { test, expect } from './harness'
import { MOBILE_PORT, newTab, pdfBytes, readState, starts, typeLine, ui, waitFor, type KoraRun } from './kora'

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

test('R-celular-gestos arrastar de lado: conversa → arquivos e de volta, conversa → lista; vertical, diagonal, borda e área que rola de lado não navegam', async ({ kora }) => {
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
  await stays([[8, middle], [width - 50, middle]], 'arrastar a partir da borda é o voltar do Android, não o do Kora')
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

  // PDF: toque simples alterna a barra de página e zoom; duplo toque é zoom e não esconde nada.
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
  await tap()
  await expect(bar, 'um toque esconde a barra').toBeHidden()
  await expect(header, 'em pé a faixa do arquivo fica').toBeVisible()
  await tap()
  await expect(bar, 'outro toque mostra a barra').toBeVisible()
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
  await expect(header).toBeVisible()
  // Longe do clique no zoom: dois toques dentro da janela do duplo toque contariam como um duplo.
  await phone.waitForTimeout(600)
  await tap()
  await expect(bar).toBeHidden()
  await expect(header, 'deitado, o toque esconde também a faixa do arquivo').toBeHidden()
  await tap()
  await expect(header).toBeVisible()
  await expect(bar).toBeVisible()
  await resize({ width: 360, height: 720 })
  await expect(phone.locator('.mobile-header'), 'em pé, o cabeçalho do Kora volta').toBeVisible()
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

test('R-celular-bandeja Kora na bandeja segue no ar: o celular vê a aba suspensa, retoma e usa o shell com a janela escondida', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await newTab(run.page, 'Terminal')
  await expect(ui.terminal(run.page)).toBeVisible()
  const { cookie } = await pairPhone(run)
  const tab = await until(async () => (await phoneTabs(cookie)).find((t) => t.live), 'aba viva para o celular')

  // O X da janela vai para a bandeja: os processos das abas acabam, mas o Kora (e o servidor do celular) continua.
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await until(async () => (await phoneTabs(cookie)).find((t) => t.id === tab.id && !t.live), 'aba suspensa vista pelo celular')
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
  expect((await fetch(`${BASE}/health`)).status).toBe(200)

  await phone(cookie, { type: 'resume', tabId: tab.id, cols: 60, rows: 24 })
  await until(async () => (await phoneTabs(cookie)).find((t) => t.id === tab.id && t.live), 'aba retomada pelo celular')
  await phone(cookie, { type: 'send', tabId: tab.id, text: "Write-Output ('NA_' + 'BANDEJA')" })
  await until(async () => (await screen(cookie, tab.id)).includes('NA_BANDEJA'), 'saída do shell retomado com a janela escondida')
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
})
