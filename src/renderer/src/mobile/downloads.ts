import { api, koraApp } from './api'

// O Android responde por window.koraBaixado para download, compartilhamento e escolha do destino.
export type DownloadEvent = { tipo: 'salvo'; nome: string; destino?: 'escolhido' } | { tipo: 'compartilhado' } | { tipo: 'cancelado' } | { tipo: 'erro'; mensagem: string }

export const canDownload = (): boolean => {
  const app = koraApp()
  return !app || typeof app.baixar === 'function'
}

// A mesma chave do microfone (voice.ts): o app a põe só na tela do Kora, então o HTML do projeto (na prévia ou aberto
// como página) não baixa nada sozinho.
const key = (): string => (window as unknown as { koraChaveAudio?: string }).koraChaveAudio ?? ''

// Uma transferência do app por vez: a resposta não diz de qual pedido é, e o Abrir do app abre o último salvo.
let inFlight = false
let listener: ((event: DownloadEvent) => void) | null = null
;(window as unknown as { koraBaixado(event: DownloadEvent): void }).koraBaixado = (event) => {
  inFlight = false
  listener?.(event)
}

// Link de leitura novo a cada download: ele vence em 30 min, e o arquivo pode estar aberto há mais tempo.
export async function download(query: string, name: string, action: 'baixar' | 'salvarComo' | 'compartilhar' = 'baixar'): Promise<'app' | 'browser'> {
  const app = koraApp()
  if (app?.[action]) {
    if (inFlight) throw new Error('Espere o download anterior terminar.')
    if (!key()) throw new Error('A tela ainda está abrindo. Tente de novo em instantes.')
    // Reservado antes de pedir o link: dois toques seguidos (ou em dois arquivos) não passam os dois.
    inFlight = true
    try {
      const { raw } = await api<{ raw: string }>(`file-link?${query}`)
      app[action]!(new URL(raw, location.origin).href, name, key())
    } catch (error) {
      inFlight = false
      throw error
    }
    return 'app'
  }
  if (action !== 'baixar') throw new Error('Atualize o app para usar esta opção.')
  const { raw } = await api<{ raw: string }>(`file-link?${query}`)
  const url = new URL(raw, location.origin).href
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  return 'browser'
}

export const openDownloaded = (): void => koraApp()?.abrirBaixado?.(key())

export function onDownloaded(handler: (event: DownloadEvent) => void): () => void {
  listener = handler
  return () => {
    if (listener === handler) listener = null
  }
}
