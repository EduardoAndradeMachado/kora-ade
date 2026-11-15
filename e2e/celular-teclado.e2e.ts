import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './harness'
import { MOBILE_PORT, newTab, readState, ui, waitFor, type KoraRun } from './kora'

const BASE = `http://127.0.0.1:${MOBILE_PORT}`

async function pairPhone(run: KoraRun): Promise<string> {
  expect((await run.page.evaluate(() => window.kora.setMobileEnabled(true))).enabled).toBe(true)
  const pairing = await run.page.evaluate(() => window.kora.pairMobile())
  const code = new URL(pairing.url).hash.replace('#pair=', '')
  const paired = await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Celular e2e' }) })
  expect(paired.status).toBe(200)
  return paired.headers.get('set-cookie')!.split(';')[0]!
}

async function openPhone(run: KoraRun, cookie: string): Promise<Page> {
  const [name, value] = cookie.split('=') as [string, string]
  const opened = run.app.waitForEvent('window')
  await run.app.evaluate(async ({ BrowserWindow, session }, { url, name, value }) => {
    await session.defaultSession.cookies.set({ url, name, value })
    void new BrowserWindow({ width: 360, height: 720, useContentSize: true }).loadURL(url)
  }, { url: `${BASE}/`, name, value })
  return opened
}

async function phoneSend(cookie: string, tabId: string, text: string): Promise<void> {
  const response = await fetch(`${BASE}/api/action`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'send', tabId, text }) })
  expect(response.status, await response.text()).toBe(200)
}

async function ptySize(cookie: string, tabId: string): Promise<{ cols: number; rows: number }> {
  const snapshot = await (await fetch(`${BASE}/api/snapshot?tab=${tabId}`, { headers: { cookie } })).json()
  return { cols: snapshot.cols, rows: snapshot.rows }
}

// Linhas do terminal (na tela do celular) que contêm o texto e se cada uma está inteira dentro da área à mostra.
function shown(phone: Page, text: string): Promise<boolean[]> {
  return phone.evaluate((text) => {
    const area = document.querySelector('.terminal-area')!.getBoundingClientRect()
    return [...document.querySelectorAll('.xterm-rows > div')]
      .filter((row) => (row.textContent ?? '').includes(text))
      .map((row) => {
        const box = row.getBoundingClientRect()
        return box.top >= area.top - 0.5 && box.bottom <= area.bottom + 0.5
      })
  }, text)
}

test('R-celular-teclado teclado ou ⋯ abertos depois de cls: o prompt no topo da tela continua à vista, sem mudar o tamanho do terminal', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const cookie = await pairPhone(run)
  await newTab(run.page, 'Terminal')
  const tabId = (await waitFor(() => readState(env).tabs[0], 'aba Terminal no estado salvo')).id

  const phone = await openPhone(run, cookie)
  await phone.locator('.tree-tab').filter({ hasText: 'Terminal' }).click()
  await expect(phone.locator('.xterm-screen')).toBeVisible()
  await phoneSend(cookie, tabId, '1..80 | % { "linha $_" }; cls; Write-Output ("MARCA_" + "TOPO")')
  await expect(phone.locator('.xterm-rows')).toContainText('MARCA_TOPO')
  await expect(phone.locator('.xterm-rows')).toContainText('PS ')
  await expect(phone.locator('.xterm-rows')).not.toContainText('linha 80')
  const size = await ptySize(cookie, tabId)
  const areaHeight = (): Promise<number> => phone.evaluate(() => document.querySelector('.terminal-area')!.clientHeight)
  const full = await areaHeight()

  await phone.getByRole('button', { name: 'Mais teclas' }).click()
  await expect(phone.getByRole('navigation', { name: 'Mais teclas do terminal' })).toBeVisible()
  await expect.poll(() => shown(phone, 'MARCA_TOPO'), { message: 'com o ⋯ aberto, a saída do topo aparece' }).toEqual([true])
  await expect.poll(() => shown(phone, 'PS '), { message: 'e o prompt também' }).toEqual([true])
  await phone.getByRole('button', { name: 'Mais teclas' }).click()

  // O teclado do Android encolhe a janela do WebView (adjustResize), não a página.
  const height = (value: number): Promise<void> => run.app.evaluate(({ BrowserWindow }, { base, value }) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith(base))!.setContentSize(360, value)
  }, { base: BASE, value })
  await phone.getByRole('textbox', { name: 'Mensagem para a sessão' }).focus()
  await height(400)
  await expect.poll(areaHeight, { message: 'o teclado tira uns 320 px da área do terminal' }).toBeLessThan(full - 250)
  console.log(`área do terminal: ${full} px, com o teclado ${await areaHeight()} px; terminal ${size.cols}x${size.rows}`)
  await expect.poll(() => shown(phone, 'MARCA_TOPO'), { message: 'com o teclado aberto, a saída do topo aparece' }).toEqual([true])
  await expect.poll(() => shown(phone, 'PS '), { message: 'e o prompt também' }).toEqual([true])

  // Com o teclado já aberto, a tela muda embaixo dele: a faixa à mostra acompanha o cursor.
  await phoneSend(cookie, tabId, '1..80 | % { "linha $_" }')
  await expect(phone.locator('.xterm-rows')).toContainText('linha 80')
  await expect.poll(() => shown(phone, 'linha 80'), { message: 'saída longa: o fim aparece, como antes' }).toEqual([true])
  await phoneSend(cookie, tabId, 'cls; Write-Output ("DE_" + "NOVO")')
  await expect(phone.locator('.xterm-rows')).toContainText('DE_NOVO')
  await expect.poll(() => shown(phone, 'DE_NOVO'), { message: 'cls com o teclado aberto: o topo volta à vista' }).toEqual([true])
  await expect.poll(() => shown(phone, 'PS '), { message: 'e o prompt também' }).toEqual([true])
  await phone.screenshot({ path: 'e2e/.results/celular-teclado-cls.png' })
  expect(await ptySize(cookie, tabId), 'abrir o teclado não muda o tamanho do terminal (o do PC é o mesmo)').toEqual(size)

  await height(720)
  await expect.poll(() => phone.evaluate(() => document.querySelector<HTMLElement>('.terminal-mount')!.style.top), { message: 'teclado fechado: o terminal volta ao lugar' }).toBe('')
  await expect.poll(() => shown(phone, 'DE_NOVO')).toEqual([true])
  expect(await ptySize(cookie, tabId)).toEqual(size)

  const field = phone.getByRole('textbox', { name: 'Mensagem para a sessão' })
  await field.fill('a'.repeat(32_770))
  await phone.getByRole('button', { name: 'Enviar' }).click()
  await expect(phone.getByRole('alert'), 'acima do limite: diz o limite e quanto passou').toContainText('A mensagem tem 32.770 caracteres e o limite é 32.768. Tire 2 para enviar.')
  await expect(field, 'o rascunho fica').toHaveValue('a'.repeat(32_770))
})

test('R-celular-link caminho que o programa cortou na margem: tocar em qualquer pedaço abre o arquivo na linha do link', async ({ kora }) => {
  const env = kora.env()
  mkdirSync(join(env.project, 'src', 'componentes'), { recursive: true })
  writeFileSync(join(env.project, 'src', 'componentes', 'Botao.tsx'), 'um\ndois\ntres\nquatro\n')
  const run = await kora.launch(env)
  const cookie = await pairPhone(run)
  await newTab(run.page, 'Terminal')
  const tabId = (await waitFor(() => readState(env).tabs[0], 'aba Terminal no estado salvo')).id

  const phone = await openPhone(run, cookie)
  await phone.locator('.tree-tab').filter({ hasText: 'Terminal' }).click()
  await expect(phone.locator('.xterm-screen')).toBeVisible()
  const { cols } = await ptySize(cookie, tabId)
  // Primeira linha até a última coluna, terminando na pasta; o resto, recuado, embaixo. Os pedaços vêm concatenados
  // para o eco do comando não conter o caminho.
  await phoneSend(cookie, tabId, `cls; Write-Output (('veja' + ' ' * ${cols - 20} + 'src/' + 'componentes/'), ('  Botao' + '.tsx:3 fim'))`)
  const rows = phone.locator('.xterm-rows > div')
  await expect(rows.filter({ hasText: 'Botao.tsx:3' })).toHaveCount(1)
  const route = (): Promise<unknown> => phone.evaluate(() => history.state?.koraMobile?.route)
  const tapText = async (text: string): Promise<void> => {
    const { x, y } = await phone.evaluate(({ text, cols }) => {
      const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect()
      const row = [...document.querySelectorAll('.xterm-rows > div')].find((element) => (element.textContent ?? '').includes(text))!
      const box = row.getBoundingClientRect()
      const column = (row.textContent ?? '').indexOf(text) + 2
      return { x: screen.left + (column + 0.5) * (screen.width / cols), y: box.top + box.height / 2 }
    }, { text, cols })
    await phone.mouse.click(x, y)
  }

  await tapText('Botao.tsx:3')
  await expect.poll(route, { message: 'o pedaço de baixo abre o caminho inteiro, na linha 3' }).toMatchObject({ file: expect.stringMatching(/src[\\/]componentes[\\/]Botao\.tsx$/), fileLine: 3 })
  await phone.goBack()
  await expect(phone.locator('.xterm-screen')).toBeVisible()
  await expect(rows.filter({ hasText: 'src/componentes/' })).toHaveCount(1)
  await tapText('src/componentes/')
  await expect.poll(route, { message: 'o pedaço de cima também' }).toMatchObject({ file: expect.stringMatching(/Botao\.tsx$/), fileLine: 3 })
})

test('R-celular-paisagem celular deitado: o terminal ganha colunas sem perder a maior parte da altura para a barra e o campo', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const cookie = await pairPhone(run)
  await newTab(run.page, 'Terminal')
  const tabId = (await waitFor(() => readState(env).tabs[0], 'aba Terminal no estado salvo')).id
  const phone = await openPhone(run, cookie)
  await phone.locator('.tree-tab').filter({ hasText: 'Terminal' }).click()
  await expect(phone.locator('.xterm-screen')).toBeVisible()
  const measure = (): Promise<{ area: number; height: number; keys: number; composer: number; strip: number }> => phone.evaluate(() => {
    const h = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().height ?? 0
    return { area: h('.terminal-area'), height: innerHeight, keys: h('.terminal-keys'), composer: h('.composer'), strip: h('.session-strip') }
  })
  const standing = await measure()
  const portrait = await ptySize(cookie, tabId)
  // Celular de 360×800 dp deitado: a barra de navegação e o recorte da câmera ficam dos lados, a de status em cima.
  await run.app.evaluate(({ BrowserWindow }, base) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith(base))!.setContentSize(740, 330)
  }, BASE)
  await expect.poll(() => phone.evaluate(() => window.matchMedia('(orientation: landscape)').matches)).toBe(true)
  await expect.poll(async () => (await ptySize(cookie, tabId)).cols, { message: 'deitado, o terminal ganha colunas' }).toBeGreaterThan(portrait.cols * 1.8)
  const lying = await measure()
  const landscape = await ptySize(cookie, tabId)
  await phone.getByRole('textbox', { name: 'Mensagem para a sessão' }).fill('rascunho deitado')
  await phone.screenshot({ path: 'e2e/.results/celular-paisagem.png' })
  console.log(`em pé: ${JSON.stringify(standing)} ${portrait.cols}x${portrait.rows}; deitado: ${JSON.stringify(lying)} ${landscape.cols}x${landscape.rows}`)
  expect(lying.area / lying.height, 'deitado, o terminal fica com a maior parte da altura').toBeGreaterThan(0.6)
})

test('R-celular-sincronia terminal comum: encerrar, abrir e fechar valem nos dois lados, com os nomes de terminal e não de conversa', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const cookie = await pairPhone(run)
  await newTab(run.page, 'Terminal')
  await waitFor(() => readState(env).tabs[0], 'aba Terminal no estado salvo')
  const phone = await openPhone(run, cookie)
  await phone.locator('.tree-tab').filter({ hasText: 'Terminal' }).click()
  await expect(phone.locator('.xterm-screen')).toBeVisible()
  const pcOpen = ui.visibleButton(run.page, 'Abrir terminal')
  const actions = async (): Promise<void> => {
    const name = (await phone.locator('.session-name').boundingBox())!
    await phone.mouse.move(name.x + 20, name.y + name.height / 2)
    await phone.mouse.down()
    await phone.waitForTimeout(700)
    await phone.mouse.up()
    await expect(phone.getByRole('dialog')).toBeVisible()
  }

  await actions()
  const sheet = phone.getByRole('dialog')
  await expect(sheet.getByRole('button', { name: 'Suspender sessão' })).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Fechar aba' }).click()
  await expect(sheet).toContainText('Fechar este terminal? O que estiver rodando nele é encerrado.')
  await expect(sheet).not.toContainText('conversa salva')
  await sheet.getByRole('button', { name: 'Cancelar' }).click()
  await sheet.getByRole('button', { name: 'Encerrar terminal' }).click()
  await expect(phone.getByRole('heading', { name: 'Terminal encerrado' }), 'encerrar no celular: o celular mostra').toBeVisible()
  await expect(pcOpen, 'e o PC também').toBeVisible()

  await phone.getByRole('button', { name: 'Abrir terminal' }).click()
  await expect(phone.locator('.xterm-screen'), 'abrir no celular').toBeVisible()
  await expect(pcOpen, 'reabre também no PC').toHaveCount(0)

  await ui.barTab(run.page, 'Terminal').click({ button: 'right' })
  await expect(ui.menuItem(run.page, 'Suspender sessão')).toHaveCount(0)
  await ui.menuItem(run.page, 'Encerrar terminal').click()
  await expect(phone.getByRole('heading', { name: 'Terminal encerrado' }), 'encerrar no PC: o celular mostra').toBeVisible()

  await ui.barTab(run.page, 'Terminal').click({ button: 'right' })
  await run.page.locator('body > div.fixed button').filter({ hasText: /^Fechar aba/ }).click()
  await expect(phone.getByText('Esta aba foi fechada.'), 'fechar no PC fecha no celular').toBeVisible()
})
