import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// Contrato: docs/api.md do repositório transcritor. O Transcritor só aceita conexão da própria máquina e lê o
// áudio pelo caminho, por isso é o Kora do PC que chama, nunca o celular.
const DEFAULT_URL = 'http://127.0.0.1:47821'
const POLL_MS = 500
// O ditado no PC tem prioridade e pausa os pedidos da API; a espera cobre um ditado longo no meio.
const TIMEOUT_MS = 5 * 60_000
// Cada chamada é local e curta: o Transcritor que aceita a conexão e não responde conta como fechado.
const CALL_MS = 15_000

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

// Resposta fora do contrato (versão nova do Transcritor, corpo cortado) vira frase, não a lista de erros do zod.
const UNKNOWN_REPLY = 'O Transcritor respondeu num formato que o Kora não conhece. Atualize o Kora ou o Transcritor.'
function parseJob(value: unknown): z.infer<typeof JobSchema> {
  const job = JobSchema.safeParse(value)
  if (!job.success) throw new Error(UNKNOWN_REPLY)
  return job.data
}

export type Transcribe = (file: string, signal: AbortSignal) => Promise<string>

export function createTranscriber(options: { url?: string; token?: () => Promise<string>; pollMs?: number; timeoutMs?: number } = {}): Transcribe {
  const base = options.url ?? DEFAULT_URL
  const pollMs = options.pollMs ?? POLL_MS
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  return async (file, signal) => {
    const token = await (options.token ?? defaultToken)()
    // cancel: o celular desistiu. A criação e o DELETE não o recebem: criar pela metade deixaria um trabalho sem id
    // para apagar, e o DELETE é justamente a limpeza depois de desistir.
    const call = async (method: string, path: string, body?: unknown, cancel?: AbortSignal): Promise<Response> => {
      const signal = cancel ? AbortSignal.any([cancel, AbortSignal.timeout(CALL_MS)]) : AbortSignal.timeout(CALL_MS)
      const init: RequestInit = { method, signal, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
      const response = await fetch(base + path, init).catch((error: unknown) => {
        if (cancel?.aborted) throw error
        throw new TranscriberUnavailableError('O Transcritor não está aberto no PC. Abra o app e tente de novo.')
      })
      if (response.ok) return response
      if (response.status === 401) throw new TranscriberUnavailableError('O Transcritor recusou o token. Feche e abra o Transcritor no PC.')
      const error = await response.json().then((result: { erro?: unknown }) => String(result.erro ?? ''), () => '')
      throw new Error(`O Transcritor falhou (${response.status}${error ? `: ${error}` : ''}).`)
    }
    const created: unknown = await (await call('POST', '/transcrever', { arquivo: file, perfil: 'ditado', cliente: 'kora-celular', esperar: true })).json().catch(() => null)
    // O id é lido à parte: com ele o trabalho é apagado mesmo que o resto da resposta não feche com o contrato.
    const id = (created as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) throw new Error(UNKNOWN_REPLY)
    try {
      const until = Date.now() + timeoutMs
      let current = parseJob(created)
      while (current.estado !== 'concluido') {
        if (current.estado === 'falhou') throw new Error(`O Transcritor não conseguiu transcrever${current.erro ? `: ${current.erro}` : '.'}`)
        if (current.estado === 'cancelado') throw new Error('A transcrição foi cancelada no PC.')
        if (Date.now() > until) throw new Error('O Transcritor demorou demais para responder. Veja se a fila dele está parada.')
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        signal.throwIfAborted()
        current = parseJob(await (await call('GET', `/trabalhos/${encodeURIComponent(id)}`, undefined, signal)).json().catch(() => null))
      }
      return (await (await call('GET', `/trabalhos/${encodeURIComponent(id)}/resultado?formato=texto`, undefined, signal)).text()).trim()
    } finally {
      // O áudio é do celular: o resultado não fica guardado no Transcritor, e apagar no meio cancela a transcrição.
      await call('DELETE', `/trabalhos/${encodeURIComponent(id)}`).catch(() => {})
    }
  }
}
