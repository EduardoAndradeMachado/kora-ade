import { test, expect } from './harness'
import { MOBILE_PORT, newTab, readState, starts, typeLine, ui, waitFor, type KoraRun } from './kora'

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
