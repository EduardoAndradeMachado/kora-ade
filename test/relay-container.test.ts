import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connect, type Sql } from '../relay/db'
import { startTestDatabase } from '../relay/testing/pg'

// O relay como roda no contêiner: "node main.ts", sem compilador. O Node só tira os tipos, e sintaxe de TypeScript que
// gera código (parâmetro "private readonly", enum) derruba o processo na subida; o vitest compilaria e esconderia isso.
let database: Awaited<ReturnType<typeof startTestDatabase>>
let sql: Sql
const children: ChildProcess[] = []

beforeAll(async () => {
  database = await startTestDatabase()
  sql = connect(database.url)
  await sql`create schema kora_sync`
}, 60_000)

afterAll(async () => {
  await sql.end()
  await database.close()
})

afterEach(() => { while (children.length) children.pop()!.kill() })

const ENV = {
  CODE_SECRET: 'x'.repeat(40),
  RESEND_API_KEY: 'chave-de-teste',
  EMAIL_FROM: 'Kora <noreply@exemplo.com>',
  EMAIL_LOGO_URL: 'https://exemplo.com/logo.png',
  HEALTH_PATH: '/saude-a8f3k2p9',
  PORT: '0',
  TRUST_PROXY: '1'
}

function run(env: Record<string, string>): { child: ChildProcess; output: () => string; exit: Promise<number | null> } {
  const child = spawn(process.execPath, ['main.ts'], { cwd: resolve('relay'), env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...env } })
  children.push(child)
  let text = ''
  child.stdout!.on('data', (chunk) => { text += chunk })
  child.stderr!.on('data', (chunk) => { text += chunk })
  return { child, output: () => text, exit: new Promise((done) => child.on('exit', done)) }
}

describe('relay como roda no contêiner', () => {
  it('recusa subir sem a configuração completa e diz o que falta', async () => {
    const { output, exit } = run({ ...ENV, CODE_SECRET: 'curto', HEALTH_PATH: '/health' })
    expect(await exit).toBe(1)
    expect(output()).toContain('DATABASE_URL ausente')
    expect(output()).toContain('CODE_SECRET ausente ou curto')
    expect(output()).toContain('HEALTH_PATH ausente ou previsível')
  })

  it('sobe com node main.ts, aplica as migrações no banco e responde o health no caminho secreto', async () => {
    const { child, output } = run({ ...ENV, DATABASE_URL: database.url })
    const port = await new Promise<number>((done, fail) => {
      child.stdout!.on('data', () => { const match = /porta (\d+)/.exec(output()); if (match) done(Number(match[1])) })
      child.on('exit', (code) => fail(new Error(`saiu com ${code}: ${output()}`)))
    })
    const health = await fetch(`http://127.0.0.1:${port}/saude-a8f3k2p9`)
    expect(health.status).toBe(200)
    expect((await health.json()).started_at).toEqual(expect.any(String))
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
    const [applied] = await sql<{ n: number }[]>`select count(*)::int as n from kora_sync.migrations`
    expect(applied!.n).toBeGreaterThan(0)
  }, 30_000)
})
