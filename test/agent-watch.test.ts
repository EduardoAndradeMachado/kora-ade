import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderWatch } from '../src/main/agent-watch'

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('watch das pastas dos agentes', () => {
  let watch: FolderWatch | undefined
  afterEach(() => watch?.stop())

  it('arquivo novo na pasta observada avisa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-sessions-'))
    let changes = 0
    watch = new FolderWatch([{ dir, recursive: false }], () => changes++, 100)
    watch.start()
    await settle(150)
    const before = changes
    writeFileSync(join(dir, '1234.json'), '{}')
    await settle(300)
    expect(changes).toBeGreaterThan(before)
  })

  it('pasta criada depois de o app abrir passa a ser observada', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'kora-home-'))
    const dir = join(parent, 'sessions')
    let changes = 0
    watch = new FolderWatch([{ dir, recursive: false }], () => changes++, 100)
    watch.start()
    await settle(150)
    mkdirSync(dir)
    await settle(300)
    const afterCreate = changes
    writeFileSync(join(dir, '1234.json'), '{}')
    await settle(300)
    expect(changes).toBeGreaterThan(afterCreate)
  })

  it('pasta observada recursivamente avisa escrita em subpasta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-rollouts-'))
    mkdirSync(join(dir, '2026', '09', '24'), { recursive: true })
    let changes = 0
    watch = new FolderWatch([{ dir, recursive: true }], () => changes++, 100)
    watch.start()
    await settle(150)
    const before = changes
    writeFileSync(join(dir, '2026', '09', '24', 'rollout.jsonl'), 'x\n')
    await settle(300)
    expect(changes).toBeGreaterThan(before)
    rmSync(dir, { recursive: true, force: true })
  })
})
