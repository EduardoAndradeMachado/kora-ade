import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RESUME_WINDOW_MS, rememberLiveTabs, takeLiveTabs } from '../src/main/resume-after-update'

const dirs: string[] = []
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kora-resume-'))
  dirs.push(dir)
  return join(dir, 'resume-after-update.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('abas que rodavam antes da atualização', () => {
  it('o app que reabre logo depois de instalar recebe as abas que rodavam', () => {
    const path = file()
    rememberLiveTabs(path, ['aba-1', 'aba-2'], 1_000)
    expect(takeLiveTabs(path, 1_000 + 60_000)).toEqual(['aba-1', 'aba-2'])
  })

  it('vale uma vez: fechar e abrir de novo depois não reabre nada', () => {
    const path = file()
    rememberLiveTabs(path, ['aba-1'], 1_000)
    takeLiveTabs(path, 2_000)
    expect(existsSync(path)).toBe(false)
    expect(takeLiveTabs(path, 3_000)).toEqual([])
  })

  it('abrir bem depois (instalação que falhou) deixa as abas suspensas e apaga a lista', () => {
    const path = file()
    rememberLiveTabs(path, ['aba-1'], 1_000)
    expect(takeLiveTabs(path, 1_000 + RESUME_WINDOW_MS + 1)).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('sem lista (fechar, sair ou desligar o PC) não reabre nada', () => {
    expect(takeLiveTabs(file(), 1_000)).toEqual([])
  })

  // Outro processo com o arquivo aberto sem deixar apagar, como o antivírus logo depois do instalador.
  it.runIf(process.platform === 'win32')('arquivo preso por outro processo não impede o app de abrir', async () => {
    const path = file()
    rememberLiveTabs(path, ['aba-1'], 1_000)
    const holder = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${path}', 'Open', 'Read', 'Read'); 'aberto'; Start-Sleep 20`])
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (data: Buffer) => { if (data.toString().includes('aberto')) resolve() })
        holder.on('exit', () => reject(new Error('o PowerShell não segurou o arquivo')))
      })
      expect(() => rmSync(path)).toThrow()
      expect(() => takeLiveTabs(path, 2_000)).not.toThrow()
    } finally {
      if (holder.exitCode === null) await new Promise((resolve) => { holder.once('exit', resolve); holder.kill() })
    }
  }, 20_000)

  it('lista corrompida não derruba a abertura e é descartada', () => {
    const path = file()
    writeFileSync(path, '{"tabIds": ["aba-1"', 'utf8')
    expect(takeLiveTabs(path, 1_000)).toEqual([])
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, JSON.stringify({ tabIds: ['aba-1', 7, null], at: 1_000 }), 'utf8')
    expect(takeLiveTabs(path, 2_000)).toEqual(['aba-1'])
  })
})
