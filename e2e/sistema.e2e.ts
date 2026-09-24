import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './harness'
import {
  appMemory,
  descendantsOf,
  installShellSpy,
  isAlive,
  newTab,
  pngBytes,
  pressNative,
  processSnapshot,
  readLog,
  readState,
  restoreClipboard,
  saveClipboard,
  shellCalls,
  spawnSecondInstance,
  starts,
  typeLine,
  ui,
  waitFor,
  writeClipboardImage,
  type KoraRun,
  type MemorySample
} from './kora'

const shells = (run: KoraRun) =>
  descendantsOf(run.pid, processSnapshot()).filter((p) => p.name.toLowerCase() === 'powershell.exe')

type Kora = Parameters<Parameters<typeof test>[2]>[0]['kora']

async function pasteImageWith(kora: Kora, keys: [string, string[]]) {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')
  const saved = await saveClipboard(run)
  let pasted: string | undefined
  try {
    await writeClipboardImage(run, pngBytes(5, 5))
    await ui.terminal(page).click()
    await pressNative(run, ...keys)
    await page.waitForTimeout(1500)
    await page.keyboard.press('Enter')
    const input = await waitFor(
      () => readLog(env).find((e) => e.event === 'input' && /kora-paste[\\/]print-.*\.png/.test(e.line ?? '')),
      `agente recebeu o caminho da imagem colada com ${keys[1].join('+')}+${keys[0]}`,
      10_000
    )
    pasted = input.line!.trim().replace(/^"|"$/g, '')
  } finally {
    await restoreClipboard(run, saved)
  }
  expect(pasted).toMatch(/\\kora-paste\\print-[^\\]+\.png$/)
  expect(pasted!.toLowerCase().startsWith(process.env['TEMP']!.toLowerCase())).toBe(true)
  expect(existsSync(pasted!)).toBe(true)
  rmSync(pasted!, { force: true })
}

test('R22 Ctrl+V com imagem no clipboard cola no terminal o caminho de um arquivo em %TEMP%\\kora-paste', async ({ kora }) => {
  await pasteImageWith(kora, ['V', ['control']])
})

test('R22b mecanismo de colar imagem (evento paste nativo via Shift+Insert) grava em kora-paste e cola o caminho', async ({ kora }) => {
  await pasteImageWith(kora, ['Insert', ['shift']])
})

test('R23 instância única: segunda instância com o mesmo KORA_USER_DATA fecha sozinha', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const before = JSON.stringify(readState(env))
  const second = await spawnSecondInstance(env)
  expect(second.code, `a segunda instância deveria sair sozinha (saiu em ${second.ms} ms)`).toBe(0)
  expect(isAlive(run.pid)).toBe(true)
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(JSON.stringify(readState(env))).toBe(before)
})

test('R25 X da janela vai para a bandeja: app segue vivo, shells das abas encerrados, aba vira Continuar e a janela volta', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await newTab(run.page, 'Claude')
  await waitFor(() => starts(env, 'claude')[0], 'claude falso subiu')
  await expect.poll(() => shells(run).length, { timeout: 30_000 }).toBe(1)

  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(() => shells(run).length, { timeout: 15_000 }).toBe(0)
  expect(isAlive(run.pid), 'o X não pode encerrar o app').toBe(true)
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
  expect(readState(env).tabs).toHaveLength(1)

  const second = await spawnSecondInstance(env)
  expect(second.code).toBe(0)
  await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
  await expect(ui.visibleButton(run.page, 'Continuar chat')).toBeVisible()
})

test('R27 link OSC 8 no terminal (o que o Claude imprime) abre no navegador sem diálogo nativo; esquema que não é http é ignorado', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  await installShellSpy(run)
  await newTab(page, 'Terminal')
  await expect.poll(() => shells(run).length, { timeout: 30_000 }).toBe(1)
  // Linha 1: link https; linha 2: link com esquema file:, que não pode sair do terminal.
  await typeLine(
    page,
    'cls; $e=[char]27; Write-Host "$e]8;;https://example.com/kora$e\\LINK-HTTPS-KORA-KORA$e]8;;$e\\"; Write-Host "$e]8;;file:///C:/Windows/win.ini$e\\LINK-FILE-KORA-KORA-KO$e]8;;$e\\"'
  )
  const box = (await ui.terminal(page).boundingBox())!
  const rowHeight = await page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows')?.children.length ?? 0
    const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect()
    return rows ? screen.height / rows : 17
  })
  const clickRow = async (row: number): Promise<void> => {
    const y = box.y + rowHeight * row + rowHeight / 2
    // O xterm guarda a resposta do link por linha enquanto o mouse fica nela: sair da linha força consultar de novo.
    await page.mouse.move(box.x + 40, y + rowHeight * 10)
    await page.mouse.move(box.x + 30, y)
    await page.mouse.move(box.x + 40, y)
    await page.mouse.click(box.x + 40, y)
  }
  // O PowerShell pode ainda não ter desenhado os links; o clique se repete até o https chegar ao navegador,
  // espaçado para dois cliques seguidos não virarem duplo clique (seleção de palavra, que desliga o link).
  await expect
    .poll(async () => {
      await clickRow(0)
      return (await shellCalls(run)).some((c) => c[0] === 'openExternal')
    }, { timeout: 20_000, intervals: [1000] })
    .toBe(true)
  await clickRow(1)
  await page.waitForTimeout(800)
  expect(await shellCalls(run)).toContainEqual(['openExternal', 'https://example.com/kora'])
  expect((await shellCalls(run)).filter((c) => c[0] === 'openExternal' && !c[1]!.startsWith('https:'))).toEqual([])
  expect(await run.nativeDialogs()).toEqual([])
})

test('R36 versão nova baixada aparece na lateral com Atualizar agora; sem versão pronta, o clique não fecha o app', async ({ kora }) => {
  const run = await kora.launch(kora.env())
  const page = run.page
  await expect(page.getByRole('status').filter({ hasText: 'pronta' })).toHaveCount(0)
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('update:ready', '9.9.9'))
  const banner = page.getByRole('status').filter({ hasText: 'Versão 9.9.9 pronta' })
  await expect(banner).toBeVisible()
  // Fora do app instalado não há atualizador: o main responde que não instalou e o botão volta.
  await banner.getByRole('button', { name: 'Atualizar agora' }).click()
  await expect(banner.getByRole('button', { name: 'Atualizar agora' })).toBeEnabled()
  expect(isAlive(run.pid)).toBe(true)
})

// Longo de propósito (KORA_E2E_SOAK_MIN=10, por exemplo): fica fora da suíte normal.
const SOAK_MIN = Number(process.env['KORA_E2E_SOAK_MIN'] ?? 0)
test('Memória em uso contínuo: terminais com saída sem parar, troca de abas, editor e painéis', async ({ kora }, testInfo) => {
  test.skip(!SOAK_MIN, 'defina KORA_E2E_SOAK_MIN para rodar')
  test.setTimeout((SOAK_MIN + 5) * 60_000)
  const env = kora.env()
  writeFileSync(join(env.project, 'codigo.ts'), Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i}`).join('\n'))
  writeFileSync(join(env.project, 'leia.md'), '# Leia\n\ntexto')
  const run = await kora.launch(env)
  const page = run.page
  for (let i = 0; i < 3; i++) await newTab(page, 'Claude')
  await waitFor(() => starts(env, 'claude').length === 3, 'três claudes falsos')
  await newTab(page, 'Terminal')
  await expect.poll(() => shells(run).length, { timeout: 30_000 }).toBe(4)
  await typeLine(page, 'while ($true) { Get-Date -Format o; Start-Sleep -Milliseconds 50 }')

  const panel = page.locator('aside').last()
  const samples: (MemorySample & { minute: number })[] = []
  const started = Date.now()
  let round = 0
  while (Date.now() - started < SOAK_MIN * 60_000) {
    round++
    const tabs = ui.tabBar(page).locator('div.group')
    const count = await tabs.count()
    for (let i = 0; i < count; i++) await tabs.nth(i).click()
    await panel.locator('div[title="codigo.ts"]').click()
    await expect(page.locator('.monaco-editor').filter({ visible: true })).toBeVisible()
    await page.keyboard.press('Control+W')
    await panel.locator('div[title="leia.md"]').click()
    await page.keyboard.press('Control+W')
    for (const view of ['Git', 'Sessões', 'Arquivos']) await panel.getByRole('button', { name: view }).click()
    await tabs.last().click()
    if (round % 6 === 0) samples.push({ ...(await appMemory(run)), minute: Math.round((Date.now() - started) / 6000) / 10 })
    await page.waitForTimeout(5000)
  }
  samples.push({ ...(await appMemory(run)), minute: Math.round((Date.now() - started) / 6000) / 10 })
  await testInfo.attach('memoria-continua.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' })
  console.log(JSON.stringify(samples.map((s) => ({ min: s.minute, total: s.workingSetMB, mainRss: s.mainRssMB, mainHeap: s.mainHeapMB, heap: s.rendererHeapMB }))))

  // Os primeiros minutos enchem o histórico de 5 mil linhas do terminal e carregam o Monaco: a base vem depois disso.
  const base = samples.find((s) => s.minute >= 2) ?? samples[0]!
  const last = samples.at(-1)!
  expect(last.rendererHeapMB, 'heap do renderer não pode crescer > 20% depois do aquecimento').toBeLessThan(base.rendererHeapMB * 1.2)
  expect(last.mainHeapMB, 'heap do main não pode crescer > 25% depois do aquecimento').toBeLessThan(base.mainHeapMB * 1.25 + 2)
  expect(last.workingSetMB, 'memória total não pode crescer > 20% depois do aquecimento').toBeLessThan(base.workingSetMB * 1.2)
})

test('Memória: 5 ciclos abrindo e fechando 10 abas de terminal', async ({ kora }, testInfo) => {
  test.setTimeout(600_000)
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  await page.waitForTimeout(3000)
  const samples = [{ cycle: 0, ...(await appMemory(run)) }]

  for (let cycle = 1; cycle <= 5; cycle++) {
    for (let i = 0; i < 10; i++) await newTab(page, 'Terminal')
    await expect.poll(() => shells(run).length, { timeout: 60_000, message: '10 PowerShells vivos' }).toBe(10)
    const open = await appMemory(run)
    while ((await ui.tabBar(page).locator('div.group').count()) > 0) {
      await ui.tabBar(page).locator('div.group').first().getByTitle('Fechar aba').click()
    }
    await expect.poll(() => shells(run).length, { timeout: 60_000, message: 'PowerShells encerrados' }).toBe(0)
    await page.waitForTimeout(2000)
    samples.push({ cycle, ...(await appMemory(run)), openWorkingSetMB: open.workingSetMB, openHeapMB: open.rendererHeapMB } as never)
  }
  await page.waitForTimeout(10_000)
  samples.push({ cycle: 99, ...(await appMemory(run)) })

  console.log(JSON.stringify(samples, null, 1))
  await testInfo.attach('memoria.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' })
  expect(readState(env).tabs).toEqual([])
  const c2 = samples[2]!
  const c5 = samples[5]!
  expect(c5.rendererHeapMB, 'heap do renderer não pode crescer > 30% entre o 2º e o 5º ciclo').toBeLessThan(c2.rendererHeapMB * 1.3)
  expect(c5.workingSetMB, 'memória total não pode crescer > 30% entre o 2º e o 5º ciclo').toBeLessThan(c2.workingSetMB * 1.3)
})

test('Órfãos: depois de matar o app à força não sobram PowerShell nem agentes vivos', async ({ kora }, testInfo) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await newTab(run.page, 'Claude')
  await newTab(run.page, 'Claude')
  await newTab(run.page, 'Terminal')
  await waitFor(() => starts(env, 'claude').length === 2, 'dois claudes falsos')
  await expect.poll(() => shells(run).length, { timeout: 30_000 }).toBe(3)
  const kids = (await run.killHard()).filter((k) => k.name.toLowerCase() !== 'electron.exe')
  const t0 = Date.now()
  const diedAt = new Map<number, number>()
  while (Date.now() - t0 < 10_000 && diedAt.size < kids.length) {
    for (const k of kids) if (!diedAt.has(k.pid) && !isAlive(k.pid)) diedAt.set(k.pid, Date.now() - t0)
    await new Promise((r) => setTimeout(r, 100))
  }
  const alive = kids.filter((k) => !diedAt.has(k.pid))
  const summary = {
    filhosAntesDoKill: kids.map((k) => `${k.name}:${k.pid}`),
    msAteMorrer: Object.fromEntries(kids.map((k) => [`${k.name}:${k.pid}`, diedAt.get(k.pid) ?? 'vivo após 10 s'])),
    vivos10sDepois: alive.map((k) => `${k.name}:${k.pid}`)
  }
  console.log(JSON.stringify(summary, null, 2))
  await testInfo.attach('orfaos.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })
  expect(alive.map((k) => k.name), 'processos órfãos 10 s depois do kill do main').toEqual([])
})
