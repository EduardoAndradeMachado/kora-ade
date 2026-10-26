import { relayHeaders } from '../../../relay/auth'
import type { AccountAction } from '../../shared/mobile'
import type { Identity } from './identity'

// A conta do Fora de casa, do lado do PC: cadastro, código, login e troca de senha nas rotas /a/... do relay. O login
// vai assinado com a chave do PC (a mesma das conexões), e é ele que registra este PC na conta.

export interface AccountClient {
  // Resolve com o corpo da resposta; o erro já vem com a mensagem do relay, pronta para a tela.
  send(action: AccountAction): Promise<{ ok: true; admin?: boolean }>
  // Tira este PC (e os celulares que só ele tinha) da conta, assinado com a chave dele; vale com o Fora de casa desligado.
  signOut(): Promise<void>
}

export function accountClient(relayUrl: string, identity: () => Identity, name: string, client: string): AccountClient {
  const base = relayUrl.replace(/^ws/, 'http')
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ ok: true; admin?: boolean }> => {
    let response: Response
    try {
      response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kora-client': client, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
      })
    } catch {
      throw new Error('Não deu para falar com o servidor do Kora. Confira a internet do PC.')
    }
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; admin?: boolean; erro?: string }
    if (!response.ok || data.ok !== true) throw new Error(data.erro ?? `O servidor do Kora respondeu ${response.status}.`)
    return { ok: true, ...(data.admin !== undefined ? { admin: data.admin } : {}) }
  }
  return {
    send(action) {
      const email = action.email.trim().toLowerCase()
      switch (action.acao) {
        case 'cadastro': return post('/a/cadastro', { email })
        case 'esqueci': return post('/a/esqueci', { email })
        case 'verificar': return post('/a/verificar', { email, codigo: action.codigo, senha: action.senha })
        case 'redefinir': return post('/a/redefinir', { email, codigo: action.codigo, senha: action.senha })
        case 'entrar': return post('/a/entrar', { email, senha: action.senha, nome: name }, relayHeaders(identity(), `/a/entrar/${email}`))
      }
    },
    async signOut() {
      await post('/a/sair', {}, relayHeaders(identity(), '/a/sair'))
    }
  }
}
