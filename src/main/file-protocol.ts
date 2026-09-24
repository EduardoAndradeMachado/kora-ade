import { pathToFileURL } from 'node:url'
import { net, protocol, type CustomScheme } from 'electron'
import { KORA_FILE_SCHEME } from '../shared/file-url'
import { KoraFileError, resolveKoraFileRequest } from './file-request'

export { KORA_FILE_SCHEME, koraFileUrl, parseKoraFileUrl } from '../shared/file-url'
export { KoraFileError, resolveKoraFileRequest } from './file-request'

// `standard` dá ao scheme URL hierárquica (caminho relativo, origem própria); `secure` evita que
// o Chromium trate o conteúdo como misto; `stream` deixa o visualizador ler o arquivo aos poucos.
export const KORA_FILE_PRIVILEGED_SCHEMES: CustomScheme[] = [
  {
    scheme: KORA_FILE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
  }
]

export function registerKoraFileProtocol(getProjectRoot: (id: string) => string): void {
  protocol.handle(KORA_FILE_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('Método não suportado', { status: 405 })
    let file: string
    try {
      file = resolveKoraFileRequest(request.url, getProjectRoot)
    } catch (err) {
      const status = err instanceof KoraFileError ? err.status : 400
      return new Response((err as Error).message, { status })
    }
    try {
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Arquivo não encontrado', { status: 404 })
    }
  })
}
