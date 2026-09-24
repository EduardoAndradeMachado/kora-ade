import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRolloutFinder, FolderWatch } from '../src/main/agent-watch'

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('rollout do Codex pelo threadId', () => {
  it('acha o arquivo na pasta do dia em que a conversa começou', () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-codex-'))
    const threadId = randomUUID()
    const day = join(root, '2026', '08', '30')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-2026-08-30T10-00-00-${randomUUID()}.jsonl`), '')
    writeFileSync(join(day, `rollout-2026-08-30T11-00-00-${threadId}.jsonl`), '')
    expect(createRolloutFinder(root)(threadId)).toBe(join(day, `rollout-2026-08-30T11-00-00-${threadId}.jsonl`))
  })

  it('arquivo que ainda não existe é procurado de novo só depois do intervalo', () => {
    const root = mkdtempSync(join(tmpdir(), 'kora-codex-'))
    const threadId = randomUUID()
    let clock = 0
    const find = createRolloutFinder(root, 3000, () => clock)
    expect(find(threadId)).toBeNull()
    const file = join(root, `rollout-2026-09-24T10-00-00-${threadId}.jsonl`)
    writeFileSync(file, '')
    clock = 1000
    expect(find(threadId)).toBeNull()
    clock = 3500
    expect(find(threadId)).toBe(file)
  })

  it('pasta de sessões inexistente (Codex nunca usado) não quebra', () => {
    expect(createRolloutFinder(join(tmpdir(), `nao-existe-${randomUUID()}`))(randomUUID())).toBeNull()
  })
})

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
