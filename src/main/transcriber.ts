import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// Contrato: docs/api.md do repositório transcritor. O Transcritor só aceita conexão da própria máquina e lê o
// áudio pelo caminho, por isso é o Kora do PC que chama, nunca o celular.
const DEFAULT_URL = 'http://127.0.0.1:47821'
const POLL_MS = 500
// O ditado no PC tem prioridade e pausa os pedidos da API; a espera cobre um ditado longo no meio.
const TIMEOUT_MS = 5 * 60_000

export class TranscriberUnavailableError extends Error {}

const JobSchema = z.object({
  id: z.string().min(1),
  estado: z.enum(['na_fila', 'transcrevendo', 'pausado', 'concluido', 'falhou', 'cancelado']),
  erro: z.string().optional()
})

async function defaultToken(): Promise<string> {
  const candidates = [
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Programs', 'Transcritor', 'dados', 'api', 'token.txt'),
    process.env['APPDATA'] && join(process.env['APPDATA'], 'transcritor', 'api', 'token.txt')
  ].filter((path): path is string => Boolean(path))
  for (const path of candidates) {
    const token = (await readFile(path, 'utf8').catch(() => '')).trim()
    if (token) return token
  }
  throw new TranscriberUnavailableError('O Transcritor não está instalado neste PC, ou nunca foi aberto.')
}

export type Transcribe = (file: string, signal: AbortSignal) => Promise<string>

export function createTranscriber(options: { url?: string; token?: () => Promise<string>; pollMs?: number; timeoutMs?: number } = {}): Transcribe {
  const base = options.url ?? DEFAULT_URL
  const pollMs = options.pollMs ?? POLL_MS
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  return async (file, signal) => {
    const token = await (options.token ?? defaultToken)()
    const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
      const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
      const response = await fetch(base + path, init).catch(() => {
        throw new TranscriberUnavailableError('O Transcritor não está aberto no PC. Abra o app e tente de novo.')
      })
      if (response.ok) return response
      if (response.status === 401) throw new TranscriberUnavailableError('O Transcritor recusou o token. Feche e abra o Transcritor no PC.')
      const error = await response.json().then((result: { erro?: unknown }) => String(result.erro ?? ''), () => '')
      throw new Error(`O Transcritor falhou (${response.status}${error ? `: ${error}` : ''}).`)
    }
    const job = JobSchema.parse(await (await call('POST', '/transcrever', { arquivo: file, perfil: 'ditado', cliente: 'kora-celular', esperar: true })).json())
    try {
      const until = Date.now() + timeoutMs
      let current = job
      while (current.estado !== 'concluido') {
        if (current.estado === 'falhou') throw new Error(`O Transcritor não conseguiu transcrever${current.erro ? `: ${current.erro}` : '.'}`)
        if (current.estado === 'cancelado') throw new Error('A transcrição foi cancelada no PC.')
        if (Date.now() > until) throw new Error('O Transcritor demorou demais para responder. Veja se a fila dele está parada.')
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        signal.throwIfAborted()
        current = JobSchema.parse(await (await call('GET', `/trabalhos/${encodeURIComponent(job.id)}`)).json())
      }
      return (await (await call('GET', `/trabalhos/${encodeURIComponent(job.id)}/resultado?formato=texto`)).text()).trim()
    } finally {
      // O áudio é do celular: o resultado não fica guardado no Transcritor, e apagar no meio cancela a transcrição.
      await call('DELETE', `/trabalhos/${encodeURIComponent(job.id)}`).catch(() => {})
    }
  }
}
