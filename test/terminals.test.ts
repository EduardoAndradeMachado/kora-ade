import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Terminals } from '../src/main/terminals'

const outputs = new Map<string, string>()
const terminals = new Terminals({
  onData: (id, data) => outputs.set(id, (outputs.get(id) ?? '') + data),
  onExit: () => {}
})

afterEach(() => terminals.killAll())

// ConPTY intercala sequências ANSI no meio do texto; sem remover, a busca por marcador não casa.
// oxlint-disable-next-line no-control-regex
const plainOutput = (id: string): string => (outputs.get(id) ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

async function waitFor(check: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando saída do terminal')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('Terminals (PowerShell real via node-pty)', () => {
  it('abre o shell na pasta do projeto', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kora-pty-')))
    const id = randomUUID()
    terminals.spawn(id, cwd, 200, 30)

    terminals.write(id, "Write-Output ('CWD=' + (Get-Location).Path)\r")

    const expected = `CWD=${cwd}`.toLowerCase()
    await waitFor(() => plainOutput(id).toLowerCase().includes(expected))
  })

  it('o shell não herda marcadores que tiram cor e desligam o salvamento de sessão do Claude', async () => {
    process.env['NO_COLOR'] = '1'
    process.env['CLAUDE_CODE_CHILD_SESSION'] = '1'
    try {
      const id = randomUUID()
      terminals.spawn(id, tmpdir(), 200, 30)
      terminals.write(id, "Write-Output ('ENV=[' + $env:NO_COLOR + '|' + $env:CLAUDE_CODE_CHILD_SESSION + '|' + $env:COLORTERM + ']')\r")
      await waitFor(() => plainOutput(id).includes('ENV=[||truecolor]'))
    } finally {
      delete process.env['NO_COLOR']
      delete process.env['CLAUDE_CODE_CHILD_SESSION']
    }
  })

  it('aba de retomada roda o comando do agente e continua como shell depois que ele sai', async () => {
    const id = randomUUID()
    const fakeBin = realpathSync(mkdtempSync(join(tmpdir(), 'kora-bin-')))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(fakeBin, 'claude.cmd'), '@echo FAKE_CLAUDE %*\r\n', 'utf8')
    const sessionId = randomUUID()
    const originalPath = process.env['PATH']
    process.env['PATH'] = `${fakeBin};${originalPath}`
    try {
      terminals.spawn(id, tmpdir(), 200, 30, { kind: 'claude', mode: 'resume', sessionId })
      await waitFor(() => plainOutput(id).includes(`FAKE_CLAUDE --resume ${sessionId}`))
      terminals.write(id, "Write-Output 'AINDA_VIVO'\r")
      await waitFor(() => plainOutput(id).includes('AINDA_VIVO'))
    } finally {
      process.env['PATH'] = originalPath
    }
  })

  it('pids expõe o processo do shell de cada aba', () => {
    const id = randomUUID()
    terminals.spawn(id, tmpdir(), 80, 24)
    expect(terminals.pids().get(id)).toBeGreaterThan(0)
  })

  it('fechar a aba encerra o shell e o agente que roda dentro dele (nada fica órfão)', async () => {
    const { listProcesses } = await import('../src/main/processes')
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kora-kill-')))
    const marker = join(dir, 'pid.txt')
    const script = join(dir, 'agente.js')
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const id = randomUUID()
    terminals.spawn(id, dir, 120, 30)
    const shellPid = terminals.pids().get(id)!
    terminals.write(id, `node "${script}"\r`)
    await waitFor(() => existsSync(marker))
    const agentPid = Number(readFileSync(marker, 'utf8'))

    terminals.kill(id)

    const alive = (pid: number): boolean => listProcesses().some((p) => p.pid === pid)
    await waitFor(() => !alive(shellPid) && !alive(agentPid), 8000)
  })

  it('fechar a aba logo depois de abrir (shell ainda subindo) também não deixa o shell órfão', async () => {
    const { listProcesses } = await import('../src/main/processes')
    const alive = (pid: number): boolean => listProcesses().some((p) => p.pid === pid)
    const pids: number[] = []
    for (let i = 0; i < 5; i++) {
      const id = randomUUID()
      terminals.spawn(id, tmpdir(), 80, 24)
      pids.push(terminals.pids().get(id)!)
      terminals.kill(id)
    }
    await waitFor(() => pids.every((pid) => !alive(pid)), 8000)
  })

  it('recusa pasta que não existe em vez de abrir em outro lugar', () => {
    expect(() => terminals.spawn(randomUUID(), join(tmpdir(), 'kora-nao-existe-xyz'), 80, 24)).toThrow(/não existe/)
  })
})
