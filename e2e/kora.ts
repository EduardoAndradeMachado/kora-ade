import { crc32, deflateSync } from 'node:zlib'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

export const ROOT = resolve(__dirname, '..')
export const BUILD_DIR = process.env['KORA_E2E_BUILD'] ?? join(ROOT, 'e2e', '.build', 'app')
const FIXTURES = join(ROOT, 'e2e', 'fixtures')
const electronPath = createRequire(join(ROOT, 'package.json'))('electron') as unknown as string
// KORA_E2E_EXE roda a suíte contra o app empacotado (distwin-unpackedKora ADE.exe), com asar e módulos nativos reais.
const PACKAGED = process.env['KORA_E2E_EXE']
const appExe = PACKAGED ?? electronPath
// gc() exposto no main: o teste de memória coleta o lixo antes de medir, senão o heap pequeno cresce até o V8 decidir coletar.
const appArgs = PACKAGED ? ['--js-flags=--expose-gc'] : ['--js-flags=--expose-gc', BUILD_DIR]

export interface KoraEnv {
  root: string
  home: string
  userData: string
  bin: string
  project: string
  log: string
  pids: string
  stateFile: string
}

export interface FakeEvent {
  t: number
  agent: 'claude' | 'codex'
  event: 'start' | 'input' | 'exit' | 'lock' | 'stdin-end'
  pid: number
  ppid: number
  cwd: string
  args?: string[]
  sessionId?: string
  threadId?: string | null
  resumed?: string | null
  line?: string
  // A linha chegou colada (marcação de colar do terminal) em vez de digitada.
  pasted?: boolean
}

export interface SavedState {
  version: 2
  projects: { id: string; name: string; path: string; hidden?: boolean }[]
  tabs: {
    id: string
    projectId: string
    title: string
    titleLocked: boolean
    agent: { kind: 'claude' | 'codex'; sessionId: string; name?: string } | null
  }[]
  settings?: { theme?: string; zoom?: number; terminalFontSize?: number; fileFontSize?: number; alerts?: { sound: boolean; windowsNotification: boolean } }
}

const cmdShim = (script: string): string => `@echo off\r\n"${process.execPath}" "${join(FIXTURES, script)}" %*\r\n`

// Os agentes reais não podem ser alcançados pela instância de teste: gastariam token e gravariam no ~ real.
function isolatedPath(bin: string): string {
  const original = Object.entries(process.env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? ''
  const kept = original.split(delimiter).filter((dir) => {
    if (!dir) return false
    return !['claude.exe', 'claude.cmd', 'claude.ps1', 'codex.exe', 'codex.cmd', 'codex.ps1'].some((f) =>
      existsSync(join(dir, f))
    )
  })
  return [bin, ...kept].join(delimiter)
}

const STRIPPED = [/^NO_COLOR$/i, /^FORCE_COLOR$/i, /^CLAUDE_CODE_/i, /^CLAUDECODE$/i, /^CLAUDE_PID$/i, /^CODEX_/i, /^ELECTRON_/i, /^KORA_/i, /^path$/i]

export function appEnv(env: KoraEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIPPED.some((re) => re.test(k))) continue
    out[k] = v
  }
  out['PATH'] = isolatedPath(env.bin)
  out['USERPROFILE'] = env.home
  out['HOME'] = env.home
  out['KORA_USER_DATA'] = env.userData
  // No app empacotado o atualizador consultaria o GitHub; nos testes ele fala com uma porta local fechada.
  out['KORA_UPDATE_FEED'] = 'http://127.0.0.1:9/'
  out['KORA_FAKE_LOG'] = env.log
  out['KORA_FAKE_PIDS'] = env.pids
  return out
}

export function makeEnv(opts: { project?: boolean } = {}): KoraEnv {
  const root = mkdtempSync(join(tmpdir(), 'kora-e2e-'))
  const env: KoraEnv = {
    root,
    home: join(root, 'home'),
    userData: join(root, 'userdata'),
    bin: join(root, 'bin'),
    project: join(root, 'proj-teste'),
    log: join(root, 'fake-agents.log'),
    pids: join(root, 'fake-pids'),
    stateFile: join(root, 'userdata', 'kora-state.json')
  }
  for (const dir of [env.home, env.userData, env.bin, env.project, env.pids]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(env.bin, 'claude.cmd'), cmdShim('fake-claude.cjs'))
  writeFileSync(join(env.bin, 'codex.cmd'), cmdShim('fake-codex.cjs'))
  writeFileSync(env.log, '')
  if (opts.project !== false) {
    writeState(env, {
      version: 2,
      projects: [{ id: 'p1', name: 'proj-teste', path: env.project }],
      tabs: []
    })
  }
  return env
}

export function writeState(env: KoraEnv, state: SavedState): void {
  writeFileSync(env.stateFile, JSON.stringify(state, null, 2))
}

export function readState(env: KoraEnv): SavedState {
  return JSON.parse(readFileSync(env.stateFile, 'utf8')) as SavedState
}

export function readLog(env: KoraEnv): FakeEvent[] {
  if (!existsSync(env.log)) return []
  return readFileSync(env.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeEvent)
}

export const starts = (env: KoraEnv, agent?: 'claude' | 'codex'): FakeEvent[] =>
  readLog(env).filter((e) => e.event === 'start' && (!agent || e.agent === agent))

export function git(cwd: string, env: KoraEnv, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Kora E2E', '-c', 'user.email=e2e@kora.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: env.home, USERPROFILE: env.home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true
    }
  ).trim()
}

export function seedRepo(env: KoraEnv): void {
  const p = env.project
  mkdirSync(join(p, 'src'), { recursive: true })
  mkdirSync(join(p, 'ignored-dir'), { recursive: true })
  writeFileSync(join(p, 'README.md'), '# Título do README\n\nParágrafo **forte**.\n')
  writeFileSync(join(p, 'src', 'app.ts'), 'export const valor = 1\n')
  writeFileSync(join(p, 'tracked.txt'), 'original\n')
  writeFileSync(join(p, '.gitignore'), 'ignored-dir/\n')
  writeFileSync(join(p, 'ignored-dir', 'x.txt'), 'ignorado\n')
  git(p, env, 'init', '-q')
  git(p, env, 'add', '-A')
  git(p, env, 'commit', '-q', '-m', 'inicial')
}

// ---------- processos ----------

export interface Proc {
  pid: number
  ppid: number
  name: string
}

export function processSnapshot(): Proc[] {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" }'
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  )
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, name] = l.split('\t')
      return { pid: Number(pid), ppid: Number(ppid), name: name ?? '' }
    })
}

export function descendantsOf(rootPid: number, all: Proc[]): Proc[] {
  const found: Proc[] = []
  const stack = [rootPid]
  const seen = new Set([rootPid])
  while (stack.length) {
    const parent = stack.pop()!
    for (const p of all) {
      if (p.ppid === parent && !seen.has(p.pid)) {
        seen.add(p.pid)
        found.push(p)
        stack.push(p.pid)
      }
    }
  }
  return found
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function fakePids(env: KoraEnv): number[] {
  if (!existsSync(env.pids)) return []
  return readdirSync(env.pids).map((f) => Number(f.replace(/\.json$/, ''))).filter(Number.isFinite)
}

async function waitExit(pid: number, timeout: number): Promise<void> {
  const until = Date.now() + timeout
  while (isAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
}

function killPid(pid: number): void {
  try {
    process.kill(pid)
  } catch {
    // já morreu
  }
}

// ---------- app ----------

export interface NativeDialogRecord {
  where: 'main' | 'renderer'
  method: string
  message?: string
}

export class KoraRun {
  readonly rendererDialogs: NativeDialogRecord[] = []
  // stdout/stderr do processo main: é onde aparecem os console.error do Kora (ex.: falha na detecção).
  readonly mainLog: string[] = []
  readonly pid: number
  readonly launcherPid: number | null
  private tracked = new Set<number>()

  constructor(
    readonly env: KoraEnv,
    readonly app: ElectronApplication,
    readonly page: Page,
    mainPid: number
  ) {
    // O Playwright sobe o Electron por um cmd.exe; o PID dele não é o do processo main.
    this.pid = mainPid
    this.launcherPid = app.process().pid ?? null
    page.on('dialog', (d) => {
      this.rendererDialogs.push({ where: 'renderer', method: d.type(), message: d.message() })
      void d.dismiss().catch(() => {})
    })
  }

  async nativeDialogs(): Promise<NativeDialogRecord[]> {
    const main = await this.app
      .evaluate(() => ((globalThis as { __koraNativeDialogs?: string[] }).__koraNativeDialogs ?? []).slice())
      .catch(() => [] as string[])
    return [...main.map((method) => ({ where: 'main' as const, method })), ...this.rendererDialogs]
  }

  // Registra os filhos atuais (shells, conhost, agentes falsos) para poder limpar o que sobrar depois.
  trackChildren(): Proc[] {
    const kids = descendantsOf(this.pid, processSnapshot())
    for (const k of kids) this.tracked.add(k.pid)
    return kids
  }

  // Fechar de verdade é o "Sair" da bandeja: o X da janela só esconde o app.
  async closeWindow(): Promise<void> {
    if (!isAlive(this.pid)) return
    this.trackChildren()
    await this.app.evaluate(({ app }) => app.quit()).catch(() => {})
    await waitExit(this.pid, 15_000)
    if (isAlive(this.pid)) killPid(this.pid)
  }

  async killHard(): Promise<Proc[]> {
    const kids = this.trackChildren()
    killPid(this.pid)
    await waitExit(this.pid, 10_000)
    return kids
  }

  cleanupProcesses(): void {
    if (isAlive(this.pid)) killPid(this.pid)
    if (this.launcherPid && isAlive(this.launcherPid)) killPid(this.launcherPid)
    for (const pid of this.tracked) if (isAlive(pid)) killPid(pid)
  }
}

export async function launch(env: KoraEnv): Promise<KoraRun> {
  const app = await _electron.launch({
    executablePath: appExe,
    args: appArgs,
    cwd: ROOT,
    env: appEnv(env),
    timeout: 60_000
  })
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { __koraNativeDialogs?: string[] }
    g.__koraNativeDialogs = []
    const canned: Record<string, unknown> = {
      showMessageBox: Promise.resolve({ response: 0, checkboxChecked: false }),
      showMessageBoxSync: 0,
      showErrorBox: undefined,
      showOpenDialog: Promise.resolve({ canceled: true, filePaths: [] }),
      showOpenDialogSync: undefined,
      showSaveDialog: Promise.resolve({ canceled: true }),
      showSaveDialogSync: undefined,
      showCertificateTrustDialog: Promise.resolve()
    }
    for (const [method, result] of Object.entries(canned)) {
      ;(dialog as unknown as Record<string, unknown>)[method] = () => {
        g.__koraNativeDialogs!.push(method)
        return result
      }
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTitle('Adicionar projeto')).toBeVisible({ timeout: 30_000 })
  const mainPid = await app.evaluate(() => process.pid)
  const run = new KoraRun(env, app, page, mainPid)
  const proc = app.process()
  proc.stdout?.on('data', (chunk: Buffer) => run.mainLog.push(chunk.toString()))
  proc.stderr?.on('data', (chunk: Buffer) => run.mainLog.push(chunk.toString()))
  return run
}

// Segunda instância do mesmo KORA_USER_DATA, fora do Playwright: deve sair sozinha.
export function spawnSecondInstance(env: KoraEnv): Promise<{ code: number | null; ms: number }> {
  const started = Date.now()
  const child = spawn(appExe, appArgs, { cwd: ROOT, env: appEnv(env), stdio: 'ignore', windowsHide: true })
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise({ code: -999, ms: Date.now() - started })
    }, 20_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, ms: Date.now() - started })
    })
  })
}

export function removeEnv(env: KoraEnv): void {
  for (const pid of fakePids(env)) if (isAlive(pid)) killPid(pid)
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(env.root, { recursive: true, force: true })
      return
    } catch {
      execFileSync('cmd.exe', ['/c', 'ping', '-n', '2', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
    }
  }
}

// ---------- UI ----------

export const ui = {
  tabBar: (page: Page): Locator => page.locator('main > div').first(),
  barTab: (page: Page, title: string | RegExp): Locator =>
    page.locator('main > div').first().locator('div.group').filter({ hasText: title }),
  sideTab: (page: Page, title: string | RegExp): Locator => page.locator('aside nav div.ml-5').filter({ hasText: title }),
  menuItem: (page: Page, label: string): Locator =>
    page.locator('body > div.fixed button').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  terminal: (page: Page): Locator => page.locator('.xterm-screen').filter({ visible: true }),
  visibleButton: (page: Page, name: string): Locator =>
    page.getByRole('button', { name, exact: true }).filter({ visible: true })
}

export async function newTab(page: Page, choice: 'Claude' | 'Codex' | 'Terminal' | 'Sessão existente'): Promise<void> {
  await ui.tabBar(page).getByTitle('Nova aba').click()
  await page.locator('body > div.fixed button').filter({ hasText: choice }).first().click()
}

export async function typeLine(page: Page, text: string): Promise<void> {
  await ui.terminal(page).click()
  await page.keyboard.type(text, { delay: 15 })
  await page.keyboard.press('Enter')
}

export async function waitFor<T>(fn: () => T | undefined | null | false, message: string, timeout = 30_000): Promise<T> {
  let value: T | undefined | null | false
  await expect
    .poll(
      () => {
        try {
          value = fn()
        } catch {
          value = undefined
        }
        return Boolean(value)
      },
      { message, timeout, intervals: [200, 300, 500] }
    )
    .toBe(true)
  return value as T
}

// ---------- espiões no main (evitam abrir Explorer/navegador de verdade) ----------

export async function answerOpenDialog(run: KoraRun, folder: string): Promise<void> {
  await run.app.evaluate(({ dialog }, dir) => {
    const g = globalThis as { __koraNativeDialogs?: string[] }
    ;(dialog as unknown as Record<string, unknown>)['showOpenDialog'] = () => {
      g.__koraNativeDialogs!.push('showOpenDialog')
      return Promise.resolve({ canceled: false, filePaths: [dir] })
    }
  }, folder)
}

export async function installShellSpy(run: KoraRun): Promise<void> {
  await run.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __koraShellCalls: string[][] }
    g.__koraShellCalls = []
    const s = shell as unknown as Record<string, unknown>
    s['openPath'] = (p: string) => {
      g.__koraShellCalls.push(['openPath', p])
      return Promise.resolve('')
    }
    s['showItemInFolder'] = (p: string) => {
      g.__koraShellCalls.push(['showItemInFolder', p])
    }
    s['openExternal'] = (url: string) => {
      g.__koraShellCalls.push(['openExternal', url])
      return Promise.resolve()
    }
    const getBuiltin = (process as unknown as { getBuiltinModule(id: string): Record<string, unknown> }).getBuiltinModule
    const cp = getBuiltin('node:child_process')
    const original = cp['spawn'] as (...a: unknown[]) => unknown
    cp['spawn'] = (exe: string, args: string[] = [], ...rest: unknown[]) => {
      if (args.some((a) => String(a).startsWith('file:'))) {
        g.__koraShellCalls.push(['spawn', exe, ...args])
        return { unref() {} }
      }
      return original(exe, args, ...rest)
    }
    ;(getBuiltin('node:module')['syncBuiltinESMExports'] as () => void)()
  })
}

export async function shellCalls(run: KoraRun): Promise<string[][]> {
  return run.app.evaluate(() => (globalThis as unknown as { __koraShellCalls?: string[][] }).__koraShellCalls ?? [])
}

// O clipboard é do sistema: guarda o que o dono tinha e devolve no fim. Electron 44 só tem a API assíncrona.
export type SavedClipboard = Record<string, string>[]

export async function saveClipboard(run: KoraRun): Promise<SavedClipboard> {
  return run.app.evaluate(async ({ clipboard }) => {
    const out: Record<string, string>[] = []
    for (const item of await clipboard.read()) {
      const entry: Record<string, string> = {}
      for (const type of item.types) {
        if (type.startsWith('electron application/')) continue
        try {
          const blob = await item.getType(type)
          if (blob instanceof Blob) entry[type] = Buffer.from(await blob.arrayBuffer()).toString('base64')
        } catch {
          // formato que não dá para reler
        }
      }
      if (Object.keys(entry).length) out.push(entry)
    }
    return out
  })
}

export async function restoreClipboard(run: KoraRun, saved: SavedClipboard): Promise<void> {
  await run.app.evaluate(async ({ clipboard, ClipboardItem }, entries) => {
    if (entries.length === 0) return clipboard.clear()
    await clipboard.write(
      entries.map(
        (e) =>
          new ClipboardItem(
            Object.fromEntries(Object.entries(e).map(([t, b64]) => [t, new Blob([Buffer.from(b64, 'base64')], { type: t })]))
          )
      )
    )
  }, saved)
}

export async function writeClipboardImage(run: KoraRun, png: Buffer): Promise<void> {
  await run.app.evaluate(async ({ clipboard, ClipboardItem }, b64) => {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' }) })])
  }, png.toString('base64'))
}

export async function readClipboardText(run: KoraRun): Promise<string> {
  return run.app.evaluate(({ clipboard }) => clipboard.readText())
}

// ---------- arquivos binários mínimos ----------

export function pngBytes(width: number, height: number): Buffer {

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set([200, (x * 40) % 255, (y * 60) % 255], 1 + x * 3)
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function pdfBytes(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const stream = 'BT /F1 18 Tf 20 100 Td (PDF E2E) Tj ET'
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

export interface MemorySample {
  workingSetMB: number
  byType: Record<string, number>
  mainRssMB: number
  mainHeapMB: number
  rendererHeapMB: number
  processes: number
}

// Heap do renderer medido depois de um GC forçado: sem isso o número oscila com o lixo ainda não coletado.
export async function appMemory(run: KoraRun): Promise<MemorySample> {
  const cdp = await run.page.context().newCDPSession(run.page)
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  await cdp.detach()
  const main = await run.app.evaluate(({ app }) => {
    ;(globalThis as { gc?: () => void }).gc?.()
    const metrics = app.getAppMetrics()
    const byType: Record<string, number> = {}
    for (const m of metrics) byType[m.type] = (byType[m.type] ?? 0) + m.memory.workingSetSize
    return { byType, rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, processes: metrics.length }
  })
  const round = (n: number): number => Math.round(n * 10) / 10
  const byType = Object.fromEntries(Object.entries(main.byType).map(([k, kb]) => [k, round(kb / 1024)]))
  return {
    workingSetMB: round(Object.values(byType).reduce((s, v) => s + v, 0)),
    byType,
    mainRssMB: round(main.rss / 1024 / 1024),
    mainHeapMB: round(main.heap / 1024 / 1024),
    rendererHeapMB: round(heap.usedSize / 1024 / 1024),
    processes: main.processes
  }
}

// Tecla pelo pipeline de entrada do navegador (como o teclado físico): passa pelo renderer e,
// se ele não tratar, pelos aceleradores do menu. O keyboard do Playwright (CDP) não executa colar.
export async function pressNative(run: KoraRun, keyCode: string, modifiers: string[]): Promise<void> {
  await run.app.evaluate(
    ({ BrowserWindow }, [key, mods]) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods } as Electron.KeyboardInputEvent)
      wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods } as Electron.KeyboardInputEvent)
    },
    [keyCode, modifiers] as const
  )
}
