import { koraApp } from './api'

// O microfone da página só abre em HTTPS, e o Kora fala HTTP na rede de casa: quem grava é o app Android
// (MainActivity.avisarAudio), que devolve o áudio por window.koraAudio.
// gravacao: o número da gravação a que o evento pertence (app 0.4.2 em diante). Erro sem número aconteceu antes de
// começar a gravar (microfone ocupado, permissão negada).
export type NativeAudioEvent = { gravacao?: number } & (
  | { tipo: 'gravando' }
  // De 0 (silêncio) a 1, a cada 80 ms enquanto grava.
  | { tipo: 'nivel'; valor: number }
  | { tipo: 'audio'; mime: string; base64: string }
  | { tipo: 'curto' }
  | { tipo: 'cancelado' }
  | { tipo: 'erro'; mensagem: string })

export const canRecord = (): boolean => typeof koraApp()?.gravarAudio === 'function'

// O app põe a chave só no documento principal; sem ela, um iframe com a mesma ponte não liga o microfone.
const key = (): string => (window as unknown as { koraChaveAudio?: string }).koraChaveAudio ?? ''
export const startRecording = (): void => koraApp()?.gravarAudio?.(key())
export const stopRecording = (send: boolean): void => koraApp()?.pararAudio?.(send, key())

export function onNativeAudio(handler: (event: NativeAudioEvent) => void): () => void {
  const target = window as unknown as { koraAudio?: (event: NativeAudioEvent) => void }
  target.koraAudio = handler
  return () => {
    if (target.koraAudio === handler) delete target.koraAudio
  }
}

export async function transcribeAudio(base64: string, mime: string, signal: AbortSignal): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const post = (): Promise<Response> => fetch('/api/audio', { method: 'POST', headers: { 'content-type': mime }, body: bytes, signal })
  // Mesma segunda tentativa do envio de imagem: depois da tela apagada, a primeira vai pela conexão que o Wi-Fi já derrubou.
  // Cancelado não tenta de novo.
  const response = await post().catch((error: unknown) => {
    if (signal.aborted) throw error
    return post()
  }).catch((error: unknown) => {
    // O fetch sem resposta nenhuma só diz "Failed to fetch".
    throw new Error(`Não deu para enviar o áudio ao PC (${error instanceof TypeError ? 'sem conexão com o PC' : error instanceof Error ? error.message : String(error)}).`)
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? 'Não deu para transcrever o áudio.')
  return result.text as string
}
