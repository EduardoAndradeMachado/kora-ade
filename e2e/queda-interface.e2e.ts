import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './harness'
import { descendantsOf, isAlive, newTab, pressNative, processSnapshot, readState, typeLine, ui, waitFor, type KoraRun } from './kora'

const shells = (run: KoraRun): number[] =>
  descendantsOf(run.pid, processSnapshot())
    .filter((p) => p.name.toLowerCase() === 'powershell.exe')
    .map((p) => p.pid)

// O que importa do Claude Code para a reconexão: liga o teclado kitty (CSI >5u), não para de escrever enquanto a
// interface está fora e lê a entrada crua (é assim que ele distingue Shift+Enter de Enter).
const PROGRAM = [
  "const { appendFileSync, writeFileSync } = require('node:fs')",
  'const [input, pidFile] = process.argv.slice(2)',
  'writeFileSync(pidFile, String(process.pid))',
  'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
  "process.stdout.write('\\x1b[>5u')",
  'let n = 0',
  'setInterval(() => process.stdout.write(`TICK ${++n}\\r\\n`), 50)',
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => appendFileSync(input, JSON.stringify(chunk) + '\\n'))",
  'process.stdin.resume()'
].join('\n')

// O texto da tela que a interface tem agora, pelo mesmo caminho do histórico gravado ao esconder na bandeja.
// Tela ainda vazia não é gravada: aí volta '' e quem espera pede de novo.
async function screenOf(run: KoraRun, tabId: string): Promise<string> {
  const file = join(run.env.userData, 'scrollback', `${tabId}.txt`)
  rmSync(file, { force: true })
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('terminal:flush-scrollback'))
  for (let waited = 0; waited < 3000 && !existsSync(file); waited += 100) await new Promise((r) => setTimeout(r, 100))
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

async function screenWith(run: KoraRun, tabId: string, text: string): Promise<string> {
  let last = ''
  await expect
    .poll(async () => (last = await screenOf(run, tabId)).includes(text), { message: `a tela mostra ${text}`, timeout: 30_000 })
    .toBe(true)
    .catch((err: Error) => {
      throw new Error(`${err.message}\nÚltima tela:\n${last}`)
    })
  return last
}

// Pedido feito com a página ainda recarregando nunca responde: com o prazo, a espera tenta de novo.
const inPage = <T = unknown>(run: KoraRun, code: string): Promise<T> =>
  run.app.evaluate(
    ({ BrowserWindow }, js) =>
      Promise.race([
        BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(js),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('a página não respondeu')), 2000))
      ]),
    code
  ) as Promise<T>

const ticks = (screen: string): number[] => [...screen.matchAll(/^TICK (\d+)$/gm)].map((m) => Number(m[1]))
const shiftEnters = (file: string): number =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line && JSON.parse(line) === '\x1b[13;2u').length : 0

test('R95 queda da interface: o terminal segue no mesmo processo, a tela volta como estava, a saída da queda aparece e o Shift+Enter segue no modo kitty', async ({ kora }) => {
  const env = kora.env()
  const input = join(env.root, 'entrada.log')
  const pidFile = join(env.root, 'programa.pid')
  writeFileSync(join(env.root, 'programa.cjs'), PROGRAM)
  writeFileSync(join(env.bin, 'programa.cmd'), `@echo off\r\n"${process.execPath}" "${join(env.root, 'programa.cjs')}" "${input}" "${pidFile}"\r\n`)
  const run = await kora.launch(env)
  const page = run.page

  await newTab(page, 'Terminal')
  await expect.poll(() => shells(run).length, { timeout: 30_000 }).toBe(1)
  // Segunda aba, fechada no estado sem o pty receber o encerramento: é o que fica quando a interface cai no meio
  // do fechamento de uma aba.
  await newTab(page, 'Terminal')
  await expect.poll(() => shells(run).length, { timeout: 30_000 }).toBe(2)
  const [kept, closed] = await waitFor(() => {
    const tabs = readState(env).tabs
    return tabs.length === 2 && tabs
  }, 'as duas abas no estado')
  await ui.barTab(page, kept!.title).first().click()
  await typeLine(page, 'programa')
  const programPid = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'o programa subiu'))
  const shellsBefore = shells(run)

  await ui.terminal(page).click()
  await pressNative(run, 'Enter', ['shift'])
  await expect.poll(() => shiftEnters(input), { message: 'antes da queda o Shift+Enter já sai no modo kitty' }).toBe(1)
  const before = await screenWith(run, kept!.id, 'TICK 4')

  await page.evaluate(
    ([ref]) => window.kora.saveTabs([ref!]),
    [{ id: kept!.id, projectId: kept!.projectId, title: kept!.title, titleLocked: kept!.titleLocked }]
  )
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer())

  // O Page do Playwright fica marcado como caído para sempre, mesmo com a janela recarregada: daqui em diante a
  // página nova é lida e operada pelo main.
  await expect
    .poll(() => inPage<boolean>(run, "document.body?.innerText.includes('Os terminais e os agentes continuaram rodando') ?? false").catch(() => false), {
      message: 'a interface voltou com o aviso da queda',
      timeout: 30_000
    })
    .toBe(true)
  await expect.poll(() => inPage<number>(run, "document.querySelectorAll('.xterm-screen').length")).toBe(1)
  expect(isAlive(programPid), 'o programa da aba continua o mesmo processo').toBe(true)
  // A aba que só existia na interface antiga perde o pty; a outra continua com o shell de antes.
  await expect.poll(() => shells(run).length, { message: 'só o shell da aba que ficou', timeout: 15_000 }).toBe(1)
  expect(shellsBefore).toContain(shells(run)[0])
  expect(readState(env).tabs.map((t) => t.id)).not.toContain(closed!.id)

  const after = await screenWith(run, kept!.id, 'programa')
  const seen = ticks(after)
  // Tudo desde o começo, uma vez cada e na ordem: a tela de antes, a saída de enquanto a interface estava fora e a
  // de depois.
  expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i + 1))
  expect(seen.length).toBeGreaterThan(ticks(before).length)

  await inPage(run, "document.querySelector('.xterm-helper-textarea')?.focus()")
  await pressNative(run, 'Enter', ['shift'])
  await expect.poll(() => shiftEnters(input), { message: 'depois da queda o Shift+Enter continua no modo kitty' }).toBe(2)
})

test('R95b recarregar a interface (o reload do desenvolvimento) também reconecta, e sair encerra o terminal', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  const page = run.page
  await newTab(page, 'Terminal')
  await expect.poll(() => shells(run).length, { timeout: 30_000 }).toBe(1)
  const tab = await waitFor(() => readState(env).tabs[0], 'aba no estado')
  const [shell] = shells(run)
  await typeLine(page, "Write-Output 'ANTES_DO_RELOAD'")
  await screenWith(run, tab.id, 'ANTES_DO_RELOAD')

  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload())
  await expect(ui.terminal(page)).toBeVisible({ timeout: 30_000 })
  await screenWith(run, tab.id, 'ANTES_DO_RELOAD')
  expect(shells(run)).toEqual([shell])
  await typeLine(page, "Write-Output 'DEPOIS_DO_RELOAD'")
  await screenWith(run, tab.id, 'DEPOIS_DO_RELOAD')

  await run.closeWindow()
  await expect.poll(() => isAlive(shell!), { timeout: 15_000 }).toBe(false)
})
