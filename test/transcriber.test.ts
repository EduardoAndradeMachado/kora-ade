import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranscriber, TranscriberUnavailableError, transcriberInstalled } from '../src/main/transcriber'
import fixture from './fixtures/transcritor-api.json'

type Reply = { status: number; contentType: string | null; body: string }
interface Seen { method: string; path: string; auth: string; body: string }

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
})

// Transcritor de mentira que devolve as respostas gravadas do de verdade, na ordem em que o trabalho anda.
async function fakeTranscritor(route: (method: string, path: string) => Reply): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    seen.push({ method: request.method ?? '', path: request.url ?? '', auth: request.headers.authorization ?? '', body })
    const reply = route(request.method ?? '', request.url ?? '')
    response.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' })
    response.end(reply.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }
}

const id = JSON.parse(fixture.post.body).id as string
const token = async (): Promise<string> => 'token-do-teste'

describe('cliente do Transcritor', () => {
  it('pede o ditado do arquivo, espera o trabalho concluir, devolve o texto e apaga o trabalho', async () => {
    let polls = 0
    const fake = await fakeTranscritor((method, path) => {
      if (method === 'POST' && path === '/transcrever') return fixture.post
      if (method === 'GET' && path === `/trabalhos/${id}`) return ++polls === 1 ? fixture.jobRunning : fixture.job
      if (method === 'GET' && path === `/trabalhos/${id}/resultado?formato=texto`) return fixture.result
      if (method === 'DELETE' && path === `/trabalhos/${id}`) return fixture.delete
      return fixture.missing
    })
    const text = await createTranscriber({ url: fake.url, token, pollMs: 5 })('C:\\Temp\\kora-audio\\fala.ogg', new AbortController().signal)
    expect(text).toBe(fixture.result.body.trim())
    expect(polls).toBe(2)
    expect(JSON.parse(fake.seen[0]!.body)).toMatchObject({ arquivo: 'C:\\Temp\\kora-audio\\fala.ogg', perfil: 'ditado', esperar: true })
    expect(fake.seen.every((call) => call.auth === 'Bearer token-do-teste')).toBe(true)
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/trabalhos/${id}` })
  })

  it('Transcritor fechado vira aviso claro em vez de erro de rede', async () => {
    const fake = await fakeTranscritor(() => fixture.missing)
    await new Promise((resolve) => servers.pop()!.close(resolve))
    const failure = createTranscriber({ url: fake.url, token })('C:\\a.ogg', new AbortController().signal)
    await expect(failure).rejects.toBeInstanceOf(TranscriberUnavailableError)
    await expect(failure).rejects.toThrow('não está aberto')
  })

  it('token recusado vira aviso de Transcritor indisponível', async () => {
    const fake = await fakeTranscritor(() => fixture.unauthorized)
    await expect(createTranscriber({ url: fake.url, token })('C:\\a.ogg', new AbortController().signal)).rejects.toBeInstanceOf(TranscriberUnavailableError)
  })

  it('trabalho que falha traz o motivo do Transcritor e ainda é apagado', async () => {
    const failed = { ...fixture.job, body: JSON.stringify({ ...JSON.parse(fixture.job.body), estado: 'falhou', erro: 'InvalidDataError: arquivo corrompido' }) }
    const fake = await fakeTranscritor((method) => (method === 'POST' ? fixture.post : method === 'DELETE' ? fixture.delete : failed))
    await expect(createTranscriber({ url: fake.url, token, pollMs: 5 })('C:\\a.ogg', new AbortController().signal)).rejects.toThrow('arquivo corrompido')
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/trabalhos/${id}` })
  })

  it('resposta fora do contrato vira frase, e o trabalho criado ainda é apagado', async () => {
    const unknown = { ...fixture.post, body: JSON.stringify({ ...JSON.parse(fixture.post.body), estado: 'estado_novo' }) }
    const fake = await fakeTranscritor((method) => (method === 'POST' ? unknown : fixture.delete))
    const failure = createTranscriber({ url: fake.url, token })('C:\\a.ogg', new AbortController().signal)
    await expect(failure).rejects.toThrow('formato que o Kora não conhece')
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/trabalhos/${id}` })
  })

  it('celular que desiste cancela o trabalho no Transcritor', async () => {
    const abort = new AbortController()
    const fake = await fakeTranscritor((method) => {
      if (method === 'POST') return fixture.post
      if (method === 'DELETE') return fixture.delete
      abort.abort()
      return fixture.jobRunning
    })
    await expect(createTranscriber({ url: fake.url, token, pollMs: 5 })('C:\\a.ogg', abort.signal)).rejects.toThrow()
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/trabalhos/${id}` })
  })

  it('desistir interrompe uma consulta que o Transcritor deixou pendurada', async () => {
    const abort = new AbortController()
    const seen: string[] = []
    const server = createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      const reply = request.method === 'POST' ? fixture.post : request.method === 'DELETE' ? fixture.delete : null
      if (!reply) return abort.abort()
      response.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' })
      response.end(reply.body)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const started = Date.now()
    await expect(createTranscriber({ url, token, pollMs: 5 })('C:\\a.ogg', abort.signal)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(seen.at(-1)).toBe(`DELETE /trabalhos/${id}`)
    server.closeAllConnections()
  })
})

describe('Transcritor instalado', () => {
  const saved = { LOCALAPPDATA: process.env['LOCALAPPDATA'], APPDATA: process.env['APPDATA'] }
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  // O celular só mostra o microfone quando isto é verdade: quem não tem o Transcritor não grava à toa.
  it('só conta como instalado com o token do Transcritor numa das duas pastas dele', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-transcritor-'))
    process.env['LOCALAPPDATA'] = join(dir, 'local')
    process.env['APPDATA'] = join(dir, 'roaming')
    expect(transcriberInstalled()).toBe(false)
    mkdirSync(join(dir, 'roaming', 'transcritor', 'api'), { recursive: true })
    writeFileSync(join(dir, 'roaming', 'transcritor', 'api', 'token.txt'), 'token')
    expect(transcriberInstalled()).toBe(true)
    process.env['APPDATA'] = join(dir, 'outra')
    mkdirSync(join(dir, 'local', 'Programs', 'Transcritor', 'dados', 'api'), { recursive: true })
    writeFileSync(join(dir, 'local', 'Programs', 'Transcritor', 'dados', 'api', 'token.txt'), 'token')
    expect(transcriberInstalled()).toBe(true)
  })
})
