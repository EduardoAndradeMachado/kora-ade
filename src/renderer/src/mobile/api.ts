// null é resposta válida do PC (snapshot de aba sem terminal): só a resposta que não é JSON conta como sem corpo.
const NOT_JSON = Symbol('sem JSON')

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(offline)
  const result = await response.json().catch(() => NOT_JSON)
  if (result === NOT_JSON) throw new Error(unreachable(response))
  if (!response.ok) throw new Error(result?.error ?? 'Não foi possível conectar ao PC.')
  return result as T
}

// O PC sempre responde com JSON. Resposta sem corpo vem da passagem do app (Passagem.kt), fora de casa: 502 quando não
// alcançou o PC pelo relay, com o motivo em X-Kora-Erro, e 403 quando a tela perdeu o cookie dela.
function unreachable(response: Response): string {
  const reason = decodeReason(response.headers.get('x-kora-erro'))
  if (response.status === 502) return `Sem conexão com o PC agora${reason ? ` (${reason.replace(/\.$/, '')})` : ''}. Confira a internet do celular; quando a conexão voltar, é só tentar de novo.`
  if (response.status === 403) return 'O app perdeu a ligação com esta tela. Feche e abra o Kora de novo.'
  return 'Não foi possível conectar ao PC.'
}

// O fetch que nem chega a uma resposta (rede caiu, PC fora do ar) só diz "Failed to fetch", em inglês.
export const NO_CONNECTION = 'Sem conexão com o PC agora. Confira a internet do celular; quando a conexão voltar, é só tentar de novo.'
export function offline(error: unknown): never {
  if (error instanceof TypeError) throw new Error(NO_CONNECTION)
  throw error
}

// O app 0.5.2 manda o motivo em percent-encoding; o 0.5.1 mandava o texto cru, que segue como veio.
function decodeReason(header: string | null): string {
  if (!header) return ''
  try {
    return decodeURIComponent(header).trim()
  } catch {
    return header.trim()
  }
}

// Ponte do app Android (android/): só existe quando a página abre dentro dele, não no navegador.
// versao e buscarAtualizacao só existem a partir do app 0.2.2: o app 0.2.1 abre esta mesma página sem eles.
// escolherPc abre a tela de PCs do app (lista, trocar, renomear, esquecer).
// gravarAudio e pararAudio só existem a partir do app 0.4.2 e pedem a chave do microfone (voice.ts); a resposta vem
// por window.koraAudio.
// baixar e abrirBaixado só existem a partir do app 0.5.2 (downloads.ts); a resposta vem por window.koraBaixado.
export interface KoraApp { lerQr(): void; escolherPc(): void; pronto(): void; versao?(): string; buscarAtualizacao?(): void; gravarAudio?(chave: string): void; pararAudio?(enviar: boolean, chave: string): void; certificado?(): string; baixar?(endereco: string, nome: string, chave: string): void; abrirBaixado?(chave: string): void }
export const koraApp = (): KoraApp | undefined => (window as unknown as { KoraApp?: KoraApp }).KoraApp
