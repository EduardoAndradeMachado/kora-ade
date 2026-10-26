export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Não foi possível conectar ao PC.')
  return result as T
}

// Ponte do app Android (android/): só existe quando a página abre dentro dele, não no navegador.
// versao e buscarAtualizacao só existem a partir do app 0.2.2: o app 0.2.1 abre esta mesma página sem eles.
// escolherPc abre a tela de PCs do app (lista, trocar, renomear, esquecer).
// gravarAudio e pararAudio só existem a partir do app 0.4.2 e pedem a chave do microfone (voice.ts); a resposta vem
// por window.koraAudio.
export interface KoraApp { lerQr(): void; escolherPc(): void; pronto(): void; versao?(): string; buscarAtualizacao?(): void; gravarAudio?(chave: string): void; pararAudio?(enviar: boolean, chave: string): void; certificado?(): string }
export const koraApp = (): KoraApp | undefined => (window as unknown as { KoraApp?: KoraApp }).KoraApp
