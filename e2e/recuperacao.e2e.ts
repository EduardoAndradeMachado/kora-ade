import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './harness'
import { launchSecondInstance, newTab, readState, tip, ui, type KoraEnv, type SavedState } from './kora'

const SESSION = '6f9619ff-8b86-4011-b42d-00c04fc964ff'

function crashedState(env: KoraEnv): void {
  const saved: SavedState = {
    version: 2,
    projects: [{ id: 'p1', name: 'proj-teste', path: env.project }],
    tabs: [{ id: 't1', projectId: 'p1', title: 'Conversa', titleLocked: true, agent: { kind: 'claude', sessionId: SESSION } }]
  }
  const text = JSON.stringify(saved, null, 2)
  writeFileSync(`${env.stateFile}.bak`, text)
  writeFileSync(env.stateFile, Buffer.alloc(text.length))
}

function orphanHistory(env: KoraEnv): string {
  const scrollback = join(env.userData, 'scrollback')
  mkdirSync(scrollback, { recursive: true })
  const history = join(scrollback, 'aba-que-a-copia-nao-conhece.txt')
  writeFileSync(history, 'histórico')
  return history
}

// Trava de verdade do Windows, como a de um antivírus: nem leitura nem rename passam enquanto o processo vive.
async function holdFile(file: string): Promise<() => void> {
  const script = `$f=[IO.File]::Open('${file}','Open','Read','None'); Write-Output pronto; Start-Sleep 120`
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((done, failed) => {
    holder.stdout.once('data', () => done())
    holder.once('exit', () => failed(new Error('não consegui segurar o arquivo')))
  })
  return () => {
    holder.removeAllListeners('exit')
    execFileSync('taskkill', ['/F', '/PID', String(holder.pid)], { stdio: 'ignore' })
  }
}

const corruptFiles = (env: KoraEnv): string[] => readdirSync(env.userData).filter((name) => name.includes('.corrupt-'))

test('estado zerado por queda volta da cópia e o aviso fica até o usuário dispensar', async ({ kora }) => {
  const env = kora.env({ project: false })
  crashedState(env)

  const run = await kora.launch(env)

  await expect(run.page.getByText('proj-teste').first()).toBeVisible()
  await expect(run.page.getByText('Conversa').first()).toBeVisible()
  const notice = run.page.getByText(/gravação da lista de projetos foi interrompida/)
  await expect(notice).toBeVisible()
  await expect.poll(() => existsSync(env.stateFile) && readState(env).projects.map((p) => p.name)).toEqual(['proj-teste'])

  await newTab(run.page, 'Claude')
  await expect(notice).toBeVisible()
  await run.page.getByRole('button', { name: 'Entendi' }).click()
  await expect(notice).toBeHidden()
})

test('histórico de aba que o estado recuperado não conhece sobrevive às aberturas seguintes', async ({ kora }) => {
  const env = kora.env({ project: false })
  crashedState(env)
  const history = orphanHistory(env)

  const first = await kora.launch(env)
  await expect(first.page.getByText('proj-teste').first()).toBeVisible()
  await first.closeWindow()
  expect(existsSync(history)).toBe(true)

  const second = await kora.launch(env)
  await expect(second.page.getByText('proj-teste').first()).toBeVisible()
  await newTab(second.page, 'Claude')
  await expect.poll(() => readState(env).tabs.length).toBeGreaterThan(1)

  expect(existsSync(history)).toBe(true)
})

test('arquivo preso abre sem gravar, avisa e fechar aba não apaga o histórico dela', async ({ kora }) => {
  const env = kora.env({ project: false })
  crashedState(env)
  copyFileSync(`${env.stateFile}.bak`, env.stateFile)
  const scrollback = join(env.userData, 'scrollback')
  mkdirSync(scrollback, { recursive: true })
  const history = join(scrollback, 't1.txt')
  writeFileSync(history, 'histórico')
  const before = readFileSync(`${env.stateFile}.bak`, 'utf8')
  const release = await holdFile(env.stateFile)

  try {
    const run = await kora.launch(env)

    await expect(run.page.getByText(/saia pelo ícone da bandeja/)).toBeVisible()
    await ui.barTab(run.page, 'Conversa').locator(tip('Fechar aba')).click()
    await expect(ui.barTab(run.page, 'Conversa')).toBeHidden()
    await run.page.waitForTimeout(1000)
  } finally {
    release()
  }

  expect(existsSync(history)).toBe(true)
  await expect.poll(() => readFileSync(env.stateFile, 'utf8')).toBe(before)
})

test('segunda abertura com o Kora aberto sai sem tocar no estado', async ({ kora }) => {
  const env = kora.env()
  const run = await kora.launch(env)
  await expect(run.page.getByText('proj-teste').first()).toBeVisible()
  writeFileSync(env.stateFile, Buffer.alloc(100))

  await launchSecondInstance(env)

  expect(corruptFiles(env)).toEqual([])
})
