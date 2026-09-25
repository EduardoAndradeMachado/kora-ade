import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './harness'
import {
  descendantsOf,
  isAlive,
  newTab,
  processSnapshot,
  readClipboardText,
  readLog,
  readState,
  restoreClipboard,
  saveClipboard,
  starts,
  typeLine,
  ui,
  waitFor,
  writeState,
  type KoraEnv
} from './kora'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function openClaude(run: { page: import('@playwright/test').Page }, env: KoraEnv, nth = 0) {
  await newTab(run.page, 'Claude')
  const start = await waitFor(() => starts(env, 'claude')[nth], `claude falso nº ${nth + 1} subiu`)
  const sessionId = start.args![1]!
  await waitFor(() => readState(env).tabs.find((t) => t.agent?.sessionId === sessionId), 'aba com a sessão no estado salvo')
  return { start, sessionId }
}

test('R3 botão + oferece Claude, Codex, Terminal e Sessão existente', async ({ kora }) => {
  const run = await kora.launch(kora.env())
  await ui.tabBar(run.page).getByTitle('Nova aba').click()
  const labels = await run.page.locator('body > div.fixed button span.font-medium').allTextContents()
  expect(labels).toEqual(['Claude', 'Codex', 'Terminal', 'Sessão existente'])
  await run.page.keyboard.press('Escape')

  // O + da linha do projeto na lateral (aparece no hover) abre o mesmo menu.
  const row = run.page.locator('aside nav div[title]').first()
  await row.hover()
  await row.getByTitle('Nova aba').click()
  const sideLabels = await run.page.locator('body > div.fixed button span.font-medium').allTextContents()
  expect(sideLabels).toEqual(['Claude', 'Codex', 'Terminal', 'Sessão existente'])
})

test('R4 aba Claude nova lança claude --session-id <uuid> e o estado salvo guarda esse uuid', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const { start, sessionId } = await openClaude(run, env)
  expect(start.args).toEqual(['--session-id', sessionId])
  expect(sessionId).toMatch(UUID)
  const tab = readState(env).tabs.find((t) => t.agent?.sessionId === sessionId)!
  expect(tab.agent!.kind).toBe('claude')
  expect(tab.projectId).toBe('p1')
})

test('R5 fechar normalmente e reabrir: aba adormecida com Continuar chat roda claude --resume <mesmo uuid>', async ({ kora }) => {
  const env = kora.env()
  const first = await kora.launch(env)
  const { sessionId } = await openClaude(first, env)
  await first.closeWindow()

  const second = await kora.launch(env)
  await expect(ui.sideTab(second.page, /.+/)).toHaveCount(1)
  const resume = ui.visibleButton(second.page, 'Continuar chat')
  await expect(resume).toBeVisible()
  await expect(second.page.getByText(sessionId).filter({ visible: true })).toBeVisible()
  await resume.click()
  const again = await waitFor(() => starts(env, 'claude')[1], 'claude falso retomado')
  expect(again.args).toEqual(['--resume', sessionId])
})

test('R6 matar o app à força e reabrir: as mesmas abas voltam e retomam a sessão', async ({ kora }) => {
  const env = kora.env()
  const first = await kora.launch(env)
  const a = await openClaude(first, env, 0)
  const b = await openClaude(first, env, 1)
  await first.killHard()

  const second = await kora.launch(env)
  const state = readState(env)
  expect(state.tabs.map((t) => t.agent?.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort())
  await expect(ui.sideTab(second.page, /.+/)).toHaveCount(2)
  await ui.visibleButton(second.page, 'Continuar chat').click()
  const resumed = await waitFor(() => starts(env, 'claude')[2], 'claude falso retomado após kill')
  expect(resumed.args![0]).toBe('--resume')
  expect([a.sessionId, b.sessionId]).toContain(resumed.args![1])
})

test('R7 aba fechada pelo usuário não volta ao reabrir (fechamento normal e kill)', async ({ kora }) => {
  const env = kora.env()
  const first = await kora.launch(env)
  const keep = await openClaude(first, env, 0)
  const gone = await openClaude(first, env, 1)
  await ui.barTab(first.page, `FakeClaude ${gone.sessionId.slice(0, 8)}`).getByTitle('Fechar aba').click()
  await waitFor(() => readState(env).tabs.length === 1, 'estado salvo sem a aba fechada')
  await first.closeWindow()

  const second = await kora.launch(env)
  expect(readState(env).tabs.map((t) => t.agent?.sessionId)).toEqual([keep.sessionId])
  await expect(ui.sideTab(second.page, /.+/)).toHaveCount(1)

  // Mesmo cenário com o app morto à força depois de fechar a aba (ritmo humano: 1 s entre as ações).
  await newTab(second.page, 'Terminal')
  await waitFor(() => readState(env).tabs.length === 2, 'aba de terminal salva')
  await second.page.waitForTimeout(1000)
  await ui.barTab(second.page, 'Terminal').getByTitle('Fechar aba').click()
  await waitFor(() => readState(env).tabs.length === 1, 'aba de terminal removida do estado')
  await second.killHard()

  const third = await kora.launch(env)
  await expect(ui.sideTab(third.page, /.+/)).toHaveCount(1)
  expect(readState(env).tabs.map((t) => t.agent?.sessionId)).toEqual([keep.sessionId])
})

test('R7b corrida: aba fechada logo após abrir, ou app fechado logo após fechar a aba, não volta', async ({ kora }) => {
  const env = kora.env()
  const first = await kora.launch(env)
  await newTab(first.page, 'Terminal')
  await waitFor(() => readState(env).tabs.length === 1, 'aba registrada pelo main no spawn')
  await ui.barTab(first.page, 'Terminal').getByTitle('Fechar aba').click()
  await expect(ui.sideTab(first.page, /.+/)).toHaveCount(0)
  await first.page.waitForTimeout(2000)
  expect.soft(readState(env).tabs, 'fechar em < 300 ms depois de abrir deixa a aba no estado do main').toEqual([])

  await newTab(first.page, 'Terminal')
  await first.page.waitForTimeout(1500)
  await ui.barTab(first.page, /Terminal/).last().getByTitle('Fechar aba').click()
  await first.closeWindow()
  const second = await kora.launch(env)
  expect.soft(readState(env).tabs, 'fechar o app < 300 ms depois de fechar a aba perde o save').toEqual([])
  await expect.soft(ui.sideTab(second.page, /.+/)).toHaveCount(0)
})

test('R8 Codex: aba nova roda codex; após a 1ª mensagem o estado ganha o uuid do lock; reabrir + Continuar roda codex resume <uuid>', async ({ kora }) => {
  const env = kora.env()
  const first = await kora.launch(env)
  await newTab(first.page, 'Codex')
  const start = await waitFor(() => starts(env, 'codex')[0], 'codex falso subiu')
  expect(start.args).toEqual([])
  await waitFor(() => readState(env).tabs.length === 1, 'aba codex no estado')
  expect(readState(env).tabs[0]!.agent).toBeNull()

  await typeLine(first.page, 'primeira mensagem')
  const lock = await waitFor(() => readLog(env).find((e) => e.event === 'lock'), 'lock do codex criado')
  const threadId = lock.threadId!
  const tab = await waitFor(
    () => readState(env).tabs.find((t) => t.agent?.kind === 'codex' && t.agent.sessionId === threadId),
    'estado salvo com o uuid do lock (detecção pelo Restart Manager)'
  )
  expect(tab.agent!.sessionId).toBe(threadId)
  await first.closeWindow()

  const second = await kora.launch(env)
  await ui.visibleButton(second.page, 'Continuar chat').click()
  const resumed = await waitFor(() => starts(env, 'codex')[1], 'codex falso retomado')
  expect(resumed.args).toEqual(['resume', threadId])
})

test('R9 claude digitado à mão numa aba Terminal é detectado e vinculado à aba', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await newTab(run.page, 'Terminal')
  await waitFor(() => readState(env).tabs.length === 1, 'aba terminal no estado')
  expect(readState(env).tabs[0]!.agent).toBeNull()
  await typeLine(run.page, 'claude')
  const start = await waitFor(() => starts(env, 'claude')[0], 'claude falso iniciado pelo usuário')
  expect(start.args).toEqual([])
  const tab = await waitFor(
    () => readState(env).tabs.find((t) => t.agent?.sessionId === start.sessionId),
    'sessão detectada e vinculada à aba Terminal'
  )
  expect(tab.agent!.kind).toBe('claude')
  expect(readState(env).tabs).toHaveLength(1)
})

test('R10 Sessão existente: vincular uuid manualmente (Claude e Codex) e recusar ID inválido', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  const form = page.locator('form').filter({ visible: true })

  await newTab(page, 'Sessão existente')
  const input = form.getByPlaceholder('ID da sessão (UUID)')
  await input.fill('isto-nao-e-uuid')
  await expect(form.getByText('Formato esperado: UUID.')).toBeVisible()
  await expect(form.getByRole('button', { name: 'Salvar' })).toBeDisabled()
  await input.press('Enter')
  await expect(form).toBeVisible()
  expect(readState(env).tabs.every((t) => t.agent === null)).toBe(true)

  const claudeId = randomUUID()
  await input.fill(claudeId)
  await form.getByRole('button', { name: 'Salvar' }).click()
  await waitFor(() => readState(env).tabs.find((t) => t.agent?.sessionId === claudeId && t.agent.kind === 'claude'), 'vínculo Claude salvo')
  await ui.visibleButton(page, 'Continuar chat').click()
  const c = await waitFor(() => starts(env, 'claude')[0], 'claude falso retomado pelo vínculo manual')
  expect(c.args).toEqual(['--resume', claudeId])

  const codexId = randomUUID()
  await newTab(page, 'Sessão existente')
  await form.getByRole('button', { name: 'Codex' }).click()
  await form.getByPlaceholder('ID da sessão (UUID)').fill(codexId)
  await form.getByRole('button', { name: 'Salvar' }).click()
  await waitFor(() => readState(env).tabs.find((t) => t.agent?.sessionId === codexId && t.agent.kind === 'codex'), 'vínculo Codex salvo')
  await ui.visibleButton(page, 'Continuar chat').click()
  const x = await waitFor(() => starts(env, 'codex')[0], 'codex falso retomado pelo vínculo manual')
  expect(x.args).toEqual(['resume', codexId])
})

test('R13 renomear aba (duplo clique e menu Renomear): nome persiste e não é sobrescrito pelo título do terminal', async ({ kora }) => {
  const env = kora.env()
  const first = await kora.launch(env)
  const { sessionId } = await openClaude(first, env)
  const short = sessionId.slice(0, 8)
  const page = first.page

  // Controle: sem nome do usuário, o título publicado pelo agente aparece na aba.
  await expect(ui.barTab(page, `FakeClaude ${short}`)).toBeVisible()

  await ui.barTab(page, `FakeClaude ${short}`).locator('span.truncate').dblclick()
  const barInput = ui.tabBar(page).locator('input')
  await barInput.fill('Meu nome')
  await barInput.press('Enter')
  await waitFor(() => readState(env).tabs.find((t) => t.title === 'Meu nome' && t.titleLocked), 'nome salvo e travado')

  await typeLine(page, 'faz algo')
  await waitFor(() => readLog(env).find((e) => e.event === 'input' && e.line === 'faz algo'), 'agente recebeu a linha e trocou o título')
  await page.waitForTimeout(1500)
  await expect(ui.barTab(page, 'Meu nome')).toBeVisible()
  expect(readState(env).tabs[0]!.title).toBe('Meu nome')

  await ui.sideTab(page, 'Meu nome').click({ button: 'right' })
  await ui.menuItem(page, 'Renomear').click()
  const sideInput = page.locator('aside nav input')
  await sideInput.fill('Nome dois')
  await sideInput.press('Enter')
  await waitFor(() => readState(env).tabs.find((t) => t.title === 'Nome dois' && t.titleLocked), 'renomear pelo menu salvo')
  await first.closeWindow()

  const second = await kora.launch(env)
  await expect(ui.sideTab(second.page, 'Nome dois')).toBeVisible()
  await ui.visibleButton(second.page, 'Continuar chat').click()
  await waitFor(() => starts(env, 'claude')[1], 'claude retomado')
  await typeLine(second.page, 'mais uma')
  await waitFor(() => readLog(env).find((e) => e.event === 'input' && e.line === 'mais uma'), 'agente retomado trocou o título')
  await second.page.waitForTimeout(1500)
  await expect(ui.barTab(second.page, 'Nome dois')).toBeVisible()
  expect(readState(env).tabs[0]!.title).toBe('Nome dois')
})

test('R14 Suspender sessão encerra o processo do agente e Continuar retoma a mesma sessão', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const { start, sessionId } = await openClaude(run, env)
  const shell = descendantsOf(run.pid, processSnapshot()).find((p) => p.name.toLowerCase() === 'powershell.exe')
  expect(isAlive(start.pid)).toBe(true)

  await ui.barTab(run.page, /FakeClaude|Claude/).click({ button: 'right' })
  await ui.menuItem(run.page, 'Suspender sessão').click()
  await waitFor(() => !isAlive(start.pid), 'processo do claude falso morreu')
  if (shell) await waitFor(() => !isAlive(shell.pid), 'PowerShell da aba morreu')
  await expect(ui.visibleButton(run.page, 'Continuar chat')).toBeVisible()
  expect(readState(env).tabs[0]!.agent!.sessionId).toBe(sessionId)

  await ui.visibleButton(run.page, 'Continuar chat').click()
  const again = await waitFor(() => starts(env, 'claude')[1], 'claude retomado após suspender')
  expect(again.args).toEqual(['--resume', sessionId])
})

test('R37 abrir um Claude num projeto e logo fechar uma aba Continuar de outro não trava o app (sem congelamento no lag.log)', async ({ kora }) => {
  const env = kora.env()
  const other = join(env.root, 'projeto-y')
  mkdirSync(other)
  writeState(env, {
    version: 2,
    projects: [
      { id: 'p1', name: 'proj-teste', path: env.project },
      { id: 'p2', name: 'projeto-y', path: other }
    ],
    tabs: [{ id: 'dormente', projectId: 'p2', title: 'Conversa antiga', titleLocked: true, agent: { kind: 'claude', sessionId: randomUUID() } }]
  })
  const run = await kora.launch(env)
  const page = run.page
  await expect(ui.sideTab(page, 'Conversa antiga')).toBeVisible()
  await page.waitForTimeout(4000)
  const since = new Date().toISOString()

  await newTab(page, 'Claude')
  const closeOld = ui.sideTab(page, 'Conversa antiga')
  await closeOld.hover()
  await closeOld.getByTitle('Fechar aba').click()
  await waitFor(() => starts(env, 'claude')[0], 'claude novo subiu')
  await waitFor(() => readState(env).tabs.every((t) => t.id !== 'dormente'), 'aba antiga fechada e salva')

  const t0 = Date.now()
  await ui.tabBar(page).getByTitle('Nova aba').click()
  await expect(page.locator('body > div.fixed button').first()).toBeVisible({ timeout: 2000 })
  expect(Date.now() - t0, 'o menu + tem que abrir rápido depois das duas ações').toBeLessThan(2000)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(3000)

  const lagFile = join(env.userData, 'lag.log')
  const freezes = (existsSync(lagFile) ? readFileSync(lagFile, 'utf8') : '')
    .split(/\r?\n/)
    .filter((line) => line && line.slice(0, 24) >= since)
    .filter((line) => Number(/(\d+) ms/.exec(line)?.[1] ?? 0) >= 1000)
  expect(freezes).toEqual([])
})


test('R51 estado do agente na aba (barra e lateral): esperando você e trabalhando, para Claude e Codex; some ao suspender', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  // O título da aba é o que o agente publica ("FakeClaude …", "FakeCodex"); o nome do agente basta para achar a aba.
  const activity = (title: RegExp) => ({
    bar: ui.barTab(page, title).locator('[data-activity]'),
    side: ui.sideTab(page, title).locator('[data-activity]')
  })

  await openClaude(run, env)
  const claude = activity(/Claude/)
  // Sem o watch das pastas, a detecção só rodaria na volta de 30 s: 5 s bastam só se o aviso vier do disco.
  await expect(claude.bar).toHaveAttribute('data-activity', 'waiting', { timeout: 5000 })
  await expect(claude.side).toHaveAttribute('data-activity', 'waiting')
  await typeLine(page, 'trabalhe')
  await expect(claude.bar).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
  await expect(claude.side).toHaveAttribute('data-activity', 'working')
  await typeLine(page, 'pare')
  await expect(claude.bar).toHaveAttribute('data-activity', 'waiting', { timeout: 5000 })

  await newTab(page, 'Codex')
  await waitFor(() => starts(env, 'codex')[0], 'codex falso subiu')
  await typeLine(page, 'trabalhe')
  const codex = activity(/Codex/)
  await expect(codex.bar).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
  await typeLine(page, 'pare')
  await expect(codex.bar).toHaveAttribute('data-activity', 'waiting', { timeout: 5000 })

  await ui.barTab(page, /Claude/).click({ button: 'right' })
  await ui.menuItem(page, 'Suspender sessão').click()
  await expect(claude.bar).toHaveCount(0)
  await expect(claude.side).toHaveCount(0)
  await expect(codex.bar).toHaveAttribute('data-activity', 'waiting')
})

test('R52 claude digitado à mão numa aba Terminal é vinculado em até 5 s (watch das pastas, não a volta periódica)', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await newTab(run.page, 'Terminal')
  await waitFor(() => readState(env).tabs.length === 1, 'aba terminal no estado')
  await typeLine(run.page, 'claude')
  const start = await waitFor(() => starts(env, 'claude')[0], 'claude falso iniciado pelo usuário')
  await waitFor(() => readState(env).tabs.find((t) => t.agent?.sessionId === start.sessionId), 'sessão vinculada pelo watch', 5000)
})

// Espiões no lugar do alto-falante e da notificação do Windows; o foco da janela fica sob controle do teste.
async function installAlertSpies(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const g = window as unknown as { __chimes: number; __notifications: { title: string; body?: string }[]; __last?: { onclick: (() => void) | null }; __focused: boolean }
    g.__chimes = 0
    g.__notifications = []
    g.__focused = true
    const Audio = window.AudioContext
    window.AudioContext = class extends Audio {
      override createBufferSource(): AudioBufferSourceNode {
        g.__chimes++
        return super.createBufferSource()
      }
    }
    window.Notification = class {
      onclick: (() => void) | null = null
      constructor(title: string, options?: NotificationOptions) {
        g.__notifications.push({ title, body: options?.body })
        g.__last = this
      }
    } as unknown as typeof Notification
    document.hasFocus = () => g.__focused
  })
  const spy = () =>
    page.evaluate(() => {
      const g = window as unknown as { __chimes: number; __notifications: { title: string; body?: string }[] }
      return { chimes: g.__chimes, notifications: g.__notifications }
    })
  const setFocused = (focused: boolean) =>
    page.evaluate((f) => {
      ;(window as unknown as { __focused: boolean }).__focused = f
      if (f) window.dispatchEvent(new Event('focus'))
    }, focused)
  return { spy, setFocused }
}

test('R56 sessão que para sem você olhar: símbolo e sino na aba, som da corda e notificação do Windows; nada para a aba vista; som desliga nas Configurações', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  const { spy, setFocused } = await installAlertSpies(page)
  const claudeAlert = ui.barTab(page, /Claude/).locator('[data-alert]')
  const claudeBell = ui.barTab(page, /Claude/).locator('[data-icon="sino"]')

  await openClaude(run, env)
  await newTab(page, 'Terminal')
  // O app mede o trabalho a partir de quando detecta o "ocupado"; com a máquina carregada isso atrasa mais de 1 s.
  // 7 s de trabalho ficam bem acima do mínimo de 3 s mesmo assim.
  const workThenLeave = async (seconds: number): Promise<void> => {
    await ui.sideTab(page, /Claude/).click()
    await typeLine(page, `trabalhe ${seconds}`)
    await expect(ui.barTab(page, /Claude/).locator('[data-activity]')).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
    await ui.sideTab(page, 'Terminal').click()
  }

  await workThenLeave(7)
  await expect(claudeAlert).toHaveCount(1, { timeout: 15_000 })
  await expect(claudeBell).toHaveCount(1)
  await expect(ui.sideTab(page, /Claude/).locator('[data-alert]')).toHaveCount(1)
  expect(await spy()).toEqual({ chimes: 1, notifications: [] })

  await ui.sideTab(page, /Claude/).click()
  await expect(claudeAlert, 'abrir a aba conta como vista').toHaveCount(0)
  await expect(claudeBell).toHaveCount(0)

  await workThenLeave(7)
  await setFocused(false)
  await expect(claudeAlert).toHaveCount(1, { timeout: 15_000 })
  const { chimes, notifications } = await spy()
  expect(chimes).toBe(2)
  expect(notifications).toEqual([{ title: 'Claude está esperando você', body: expect.stringContaining('proj-teste') }])
  await page.evaluate(() => (window as unknown as { __last: { onclick: () => void } }).__last.onclick())
  await expect(ui.barTab(page, /Claude/)).toHaveClass(/bg-secondary(?!\/)/)
  await expect(claudeAlert, 'sem foco, a aba na tela ainda não foi vista').toHaveCount(1)
  await setFocused(true)
  await expect(claudeAlert).toHaveCount(0)

  await typeLine(page, 'trabalhe 7')
  await expect(ui.barTab(page, /Claude/).locator('[data-activity]')).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
  await expect(ui.barTab(page, /Claude/).locator('[data-activity]')).toHaveAttribute('data-activity', 'waiting', { timeout: 15_000 })
  await page.waitForTimeout(500)
  await expect(claudeAlert, 'a aba que você está olhando não avisa').toHaveCount(0)
  expect((await spy()).chimes).toBe(2)

  await page.getByTitle('Configurações').click()
  const sound = page.getByRole('switch', { name: 'Som quando uma sessão para' })
  await expect(sound).toHaveAttribute('aria-checked', 'true')
  await sound.click()
  await expect(sound).toHaveAttribute('aria-checked', 'false')
  await waitFor(() => readState(env).settings?.alerts?.sound === false, 'som desligado salvo')
  await page.keyboard.press('Escape')

  await workThenLeave(7)
  await expect(claudeAlert).toHaveCount(1, { timeout: 15_000 })
  expect((await spy()).chimes, 'som desligado não toca, o aviso visual continua').toBe(2)
})

test('R57 aviso de sessão parada também no Codex: símbolo e sino na aba e som da corda; abrir a aba limpa', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  const { spy } = await installAlertSpies(page)
  const codexAlert = ui.barTab(page, /Codex/).locator('[data-alert]')

  await newTab(page, 'Codex')
  await waitFor(() => starts(env, 'codex')[0], 'codex falso subiu')
  await newTab(page, 'Terminal')
  await ui.sideTab(page, /Codex/).click()
  await typeLine(page, 'trabalhe 7')
  await expect(ui.barTab(page, /Codex/).locator('[data-activity]')).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
  await ui.sideTab(page, 'Terminal').click()

  await expect(codexAlert).toHaveCount(1, { timeout: 15_000 })
  await expect(ui.barTab(page, /Codex/).locator('[data-icon="sino"]')).toHaveCount(1)
  await expect(ui.sideTab(page, /Codex/).locator('[data-alert]')).toHaveCount(1)
  expect(await spy()).toEqual({ chimes: 1, notifications: [] })

  await ui.sideTab(page, /Codex/).click()
  await expect(codexAlert).toHaveCount(0)
})

test('R58 easter egg: sino tocando em outra sessão faz o símbolo da tela vazia balançar', async ({ kora }) => {
  const env = kora.env()
  const other = join(env.root, 'vazio')
  mkdirSync(other)
  writeState(env, {
    version: 2,
    projects: [
      { id: 'p1', name: 'proj-teste', path: env.project },
      { id: 'p2', name: 'vazio', path: other }
    ],
    tabs: []
  })
  const run = await kora.launch(env)
  const page = run.page
  await installAlertSpies(page)
  const emptySymbol = page.locator('main [data-empty-symbol]')

  await newTab(page, 'Codex')
  await waitFor(() => starts(env, 'codex')[0], 'codex falso subiu')
  await typeLine(page, 'trabalhe 7')
  await expect(ui.barTab(page, /Codex/).locator('[data-activity]')).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
  await page.locator('aside nav div[title]').filter({ hasText: 'vazio' }).click()
  await expect(emptySymbol).toBeVisible()
  await expect(emptySymbol).not.toHaveClass(/kora-balanca/)

  await expect(emptySymbol).toHaveClass(/kora-balanca/, { timeout: 15_000 })
  // A classe sozinha passaria com o CSS da animação quebrado: a animação tem que estar rodando no símbolo e as etapas
  // dela têm que girar de verdade. Não mede o ângulo ao longo do tempo: com a janela de teste escondida atrás de
  // outras, o Electron congela as animações e o ângulo não anda, sem nada estar quebrado.
  const swing = await emptySymbol.evaluate((el) => {
    const animation = el.getAnimations().find((a) => (a as CSSAnimation).animationName === 'kora-balanca')
    if (!animation) return null
    const turns = (animation.effect as KeyframeEffect).getKeyframes().map((k) => String(k['transform'] ?? ''))
    return { state: animation.playState, turns }
  })
  expect(swing?.state, 'animação kora-balanca rodando no símbolo').toBe('running')
  expect(swing!.turns.filter((t) => /rotate\(-?[1-9]/.test(t)).length, 'etapas com rotação').toBeGreaterThan(2)
})

test('R62 aba adormecida com sessão mostra só Continuar chat e o ID; aba sem sessão mantém Abrir terminal e Vincular', async ({ kora }) => {
  const env = kora.env()
  const sessionId = randomUUID()
  writeState(env, {
    version: 2,
    projects: [{ id: 'p1', name: 'proj-teste', path: env.project }],
    tabs: [
      { id: 't1', projectId: 'p1', title: 'Com sessão', titleLocked: true, agent: { kind: 'claude', sessionId } },
      { id: 't2', projectId: 'p1', title: 'Sem sessão', titleLocked: true, agent: null }
    ]
  })
  const run = await kora.launch(env)
  const page = run.page
  const view = page.locator('[data-dormant]').filter({ visible: true })

  await ui.sideTab(page, 'Com sessão').click()
  await expect(view.getByRole('button', { name: 'Continuar chat' })).toBeVisible()
  const copy = view.getByTitle('Copiar ID da sessão')
  await expect(copy).toContainText(sessionId)
  await expect(view.getByText('Abrir terminal vazio')).toHaveCount(0)
  await expect(view.getByText('Trocar a sessão vinculada')).toHaveCount(0)
  await expect(view.getByRole('button'), 'só Continuar chat e o ID').toHaveCount(2)

  const saved = await saveClipboard(run)
  try {
    await expect(view.getByText('Copiado')).toHaveCount(0)
    await copy.click()
    await expect(view.getByText('Copiado'), 'confirmação na hora, no próprio botão').toBeVisible()
    expect(await readClipboardText(run)).toBe(sessionId)
    await expect(view.getByText('Copiado')).toHaveCount(0, { timeout: 5000 })

    await ui.sideTab(page, 'Com sessão').click({ button: 'right' })
    await ui.menuItem(page, 'Copiar ID da sessão').click()
    await expect(page.getByText('ID da sessão copiado'), 'aviso ao copiar pelo menu').toBeVisible()
  } finally {
    await restoreClipboard(run, saved)
  }

  await ui.sideTab(page, 'Sem sessão').click()
  await expect(view.getByRole('button', { name: 'Abrir terminal' })).toBeVisible()
  await expect(view.getByText('Vincular uma sessão manualmente')).toBeVisible()
})

test('R63 Claude que termina deixando comando em segundo plano ("shell") está esperando você: sino toca e a rodinha para', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  const { spy } = await installAlertSpies(page)
  const claudeTab = () => ui.barTab(page, /Claude/)

  await openClaude(run, env)
  await newTab(page, 'Terminal')
  await ui.sideTab(page, /Claude/).click()
  await typeLine(page, 'trabalhe-bg 7')
  await expect(claudeTab().locator('[data-activity]')).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
  await ui.sideTab(page, 'Terminal').click()

  await expect(claudeTab().locator('[data-alert]'), 'aviso de sessão parada').toHaveCount(1, { timeout: 15_000 })
  expect((await spy()).chimes, 'a corda tocou').toBe(1)
  await ui.sideTab(page, /Claude/).click()
  await expect(claudeTab().locator('[data-activity]'), 'sem rodinha: esperando você').toHaveAttribute('data-activity', 'waiting')
  await expect(claudeTab().locator('.kora-spin')).toHaveCount(0)
})

test('R67 Claude que encerra o turno com subagente em segundo plano (arquivo do pid segue "busy") está esperando você', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  const { spy } = await installAlertSpies(page)
  const claudeTab = () => ui.barTab(page, /Claude/)

  await openClaude(run, env)
  await newTab(page, 'Terminal')
  await ui.sideTab(page, /Claude/).click()
  await typeLine(page, 'trabalhe-sub 7')
  await expect(claudeTab().locator('[data-activity]')).toHaveAttribute('data-activity', 'working', { timeout: 5000 })
  await ui.sideTab(page, 'Terminal').click()

  await expect(claudeTab().locator('[data-alert]'), 'aviso de sessão parada').toHaveCount(1, { timeout: 12_000 })
  expect((await spy()).chimes, 'a corda tocou').toBe(1)
  await ui.sideTab(page, /Claude/).click()
  await expect(claudeTab().locator('[data-activity]'), 'sem rodinha: esperando você').toHaveAttribute('data-activity', 'waiting')
  await expect(claudeTab().locator('.kora-spin')).toHaveCount(0)
})
