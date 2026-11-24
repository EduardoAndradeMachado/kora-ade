import { describe, expect, it } from 'vitest'
import { cachedResolver, type ResolvedPath } from '../src/renderer/src/mobile/path-cache'

describe('cache dos caminhos do modo texto', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('arquivo achado não pergunta de novo ao PC', async () => {
    let asks = 0
    const resolve = cachedResolver('p-achado', async () => { asks++; return { rel: 'src/a.ts', line: null } })
    expect(await resolve('src/a.ts')).toEqual({ rel: 'src/a.ts', line: null })
    expect(await resolve('src/a.ts')).toEqual({ rel: 'src/a.ts', line: null })
    expect(asks).toBe(1)
  })

  it('o que ainda não existe é perguntado de novo depois do prazo (o agente cria o arquivo depois de citar)', async () => {
    let clock = 1000
    let exists = false
    let asks = 0
    const resolve = cachedResolver('p-criado', async (): Promise<ResolvedPath | null> => { asks++; return exists ? { rel: 'src/novo.ts', line: null } : null }, () => clock)
    expect(await resolve('src/novo.ts')).toBeNull()
    await settle()
    expect(await resolve('src/novo.ts')).toBeNull()
    expect(asks).toBe(1)
    exists = true
    clock += 31_000
    expect(await resolve('src/novo.ts')).toEqual({ rel: 'src/novo.ts', line: null })
    expect(asks).toBe(2)
  })

  it('falha de rede não fica guardada: a próxima vez pergunta de novo', async () => {
    let fail = true
    let asks = 0
    const resolve = cachedResolver('p-rede', async () => { asks++; if (fail) throw new Error('Sem conexão com o PC.'); return { rel: 'a.md', line: 3 } })
    expect(await resolve('a.md:3')).toBeNull()
    await settle()
    fail = false
    expect(await resolve('a.md:3')).toEqual({ rel: 'a.md', line: 3 })
    expect(asks).toBe(2)
  })
})
