import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgyCredentialStore } from '../src/main/antigravity'
import { agyCredentialIdentity, AntigravityAccounts } from '../src/main/antigravity-accounts'

// Mesmo formato que o agy 1.5.13 grava em gemini:antigravity (capturado em 2026-11-21, valores trocados).
function credential(who: 'a' | 'b' | 'c', generation = 1): string {
  return JSON.stringify({
    token: {
      access_token: `ya29.at-${who}-${generation}`,
      token_type: 'Bearer',
      refresh_token: `1//rt-${who}`,
      expiry: '2026-11-21T17:59:17.30856-03:00',
      expires_in: 3599
    },
    auth_method: 'consumer',
    id_token_email: `${who}@exemplo.com`
  })
}

let root: string
let keyring: string | null
let running: number
let activeChanges: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kora-agy-accounts-'))
  keyring = credential('a')
  running = 0
  activeChanges = 0
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const vaultFile = (): string => join(root, 'antigravity-accounts.json')

const store: AgyCredentialStore = {
  read: () => keyring,
  write: (raw) => {
    keyring = raw
  },
  remove: () => {
    keyring = null
  }
}

function accounts(): AntigravityAccounts {
  return new AntigravityAccounts({
    store,
    vaultFile: vaultFile(),
    secrets: {
      encrypt: (plain) => `cifrado:${Buffer.from(plain).toString('base64')}`,
      decrypt: (cipher) => {
        if (!cipher.startsWith('cifrado:')) throw new Error('segredo inválido')
        return Buffer.from(cipher.slice('cifrado:'.length), 'base64').toString()
      }
    },
    runningAgy: () => running,
    onActiveChange: () => {
      activeChanges++
    }
  })
}

// Login de outra conta entrando por fora do Kora, como faz o /login do agy.
async function signInOutside(a: AntigravityAccounts, who: 'a' | 'b' | 'c'): Promise<void> {
  keyring = credential(who)
  await a.list()
}

describe('AntigravityAccounts', () => {
  it('guarda o login atual do agy como primeira conta, sem o token sair cifrado', async () => {
    const view = await accounts().list()
    expect(view).toEqual({ accounts: [{ id: 'a@exemplo.com', email: 'a@exemplo.com', active: true }], activeUnknown: false, adding: false })
    const vault = readFileSync(vaultFile(), 'utf8')
    expect(vault).not.toContain('ya29.at-a')
    expect(vault).not.toContain('1//rt-a')
  })

  it('troca a credencial do agy pela da conta escolhida, byte a byte', async () => {
    const a = accounts()
    await a.list()
    await signInOutside(a, 'b')
    const view = await a.switchTo('a@exemplo.com')
    expect(keyring).toBe(credential('a'))
    expect(view.accounts.find((x) => x.active)?.email).toBe('a@exemplo.com')
    await a.switchTo('b@exemplo.com')
    expect(keyring).toBe(credential('b'))
  })

  it('guarda a renovação mais nova da conta que sai antes de trocar', async () => {
    const a = accounts()
    await a.list()
    await signInOutside(a, 'b')
    await a.switchTo('a@exemplo.com')
    // O agy abriu na conta A e renovou o access_token sem o Kora sincronizar.
    keyring = credential('a', 2)
    await a.switchTo('b@exemplo.com')
    await a.switchTo('a@exemplo.com')
    expect(keyring).toBe(credential('a', 2))
  })

  it('não troca com agy aberto e não mexe na credencial', async () => {
    const a = accounts()
    await a.list()
    await signInOutside(a, 'b')
    running = 2
    await expect(a.switchTo('a@exemplo.com')).rejects.toThrow(/Feche os 2 agy abertos/)
    expect(keyring).toBe(credential('b'))
    running = 1
    await expect(a.switchTo('a@exemplo.com')).rejects.toThrow(/Feche o agy/)
    expect(keyring).toBe(credential('b'))
  })

  it('não troca quando não reconhece a conta logada, para não perdê-la', async () => {
    const a = accounts()
    await a.list()
    await signInOutside(a, 'b')
    keyring = JSON.stringify({ token: { access_token: 'x', refresh_token: 'y' } })
    const view = await a.list()
    expect(view.activeUnknown).toBe(true)
    await expect(a.switchTo('a@exemplo.com')).rejects.toThrow(/Não reconheci a conta/)
    expect(keyring).toBe(JSON.stringify({ token: { access_token: 'x', refresh_token: 'y' } }))
  })

  it('adicionar conta guarda a atual, esvazia o login e adota o que o agy gravar depois', async () => {
    const a = accounts()
    await a.list()
    keyring = credential('a', 3)
    const adding = await a.startAdding()
    expect(keyring).toBeNull()
    expect(adding.adding).toBe(true)
    expect(adding.accounts.some((x) => x.active)).toBe(false)

    keyring = credential('b')
    const view = await a.list()
    expect(view.adding).toBe(false)
    expect(view.accounts.map((x) => [x.email, x.active])).toEqual([
      ['a@exemplo.com', false],
      ['b@exemplo.com', true]
    ])
    await a.switchTo('a@exemplo.com')
    expect(keyring).toBe(credential('a', 3))
  })

  it('não adiciona conta com agy aberto', async () => {
    const a = accounts()
    await a.list()
    running = 1
    await expect(a.startAdding()).rejects.toThrow(/Feche o agy/)
    expect(keyring).toBe(credential('a'))
  })

  it('cancelar a conta nova devolve a anterior quando o agy não gravou nada', async () => {
    const a = accounts()
    await a.list()
    await a.startAdding()
    const view = await a.cancelAdding()
    expect(keyring).toBe(credential('a'))
    expect(view).toMatchObject({ adding: false, accounts: [{ email: 'a@exemplo.com', active: true }] })
  })

  it('durante a conta nova, a anterior não pode ser removida: o login dela só existe no Kora', async () => {
    const a = accounts()
    await a.list()
    await a.startAdding()
    await expect(a.remove('a@exemplo.com')).rejects.toThrow(/volta se a conta nova for cancelada/)
    await a.cancelAdding()
    expect(keyring).toBe(credential('a'))
  })

  it('login não reconhecido durante a conta nova encerra a espera e aparece como não identificado', async () => {
    const a = accounts()
    await a.list()
    await a.startAdding()
    keyring = JSON.stringify({ token: { access_token: 'x' } })
    expect(await a.list()).toMatchObject({ adding: false, activeUnknown: true })
  })

  it('cancelar que falha ao gravar o login continua esperando e pode tentar de novo', async () => {
    const a = accounts()
    await a.list()
    await a.startAdding()
    const write = store.write
    store.write = () => {
      throw new Error('Cofre de Credenciais recusou')
    }
    try {
      await expect(a.cancelAdding()).rejects.toThrow(/recusou/)
    } finally {
      store.write = write
    }
    expect((await a.list()).adding).toBe(true)
    await a.cancelAdding()
    expect(keyring).toBe(credential('a'))
  })

  it('não cancela a conta nova com agy aberto', async () => {
    const a = accounts()
    await a.list()
    await a.startAdding()
    running = 1
    await expect(a.cancelAdding()).rejects.toThrow(/Feche o agy/)
    expect(keyring).toBeNull()
  })

  it('cancelar depois de o agy gravar um login novo mantém o login novo', async () => {
    const a = accounts()
    await a.list()
    await a.startAdding()
    keyring = credential('c')
    await a.cancelAdding()
    expect(keyring).toBe(credential('c'))
  })

  it('sem login no agy, troca para uma conta guardada', async () => {
    const a = accounts()
    await a.list()
    keyring = null
    expect((await a.list()).accounts.some((x) => x.active)).toBe(false)
    await a.switchTo('a@exemplo.com')
    expect(keyring).toBe(credential('a'))
  })

  it('avisa a troca de conta ativa para a cota não mostrar a anterior', async () => {
    const a = accounts()
    await a.list()
    expect(activeChanges).toBe(0)
    await signInOutside(a, 'b')
    expect(activeChanges).toBe(1)
    await a.switchTo('a@exemplo.com')
    expect(activeChanges).toBe(2)
    await a.list()
    expect(activeChanges).toBe(2)
  })

  it('não remove a conta em uso; remove a outra', async () => {
    const a = accounts()
    await a.list()
    await signInOutside(a, 'b')
    await expect(a.remove('b@exemplo.com')).rejects.toThrow(/em uso/)
    const view = await a.remove('a@exemplo.com')
    expect(view.accounts.map((x) => x.email)).toEqual(['b@exemplo.com'])
    await expect(a.switchTo('a@exemplo.com')).rejects.toThrow(/não encontrada/)
  })

  it('cofre ilegível fica guardado ao lado e as contas recomeçam pelo login atual', async () => {
    writeFileSync(vaultFile(), '{quebrado', 'utf8')
    const view = await accounts().list()
    expect(view.accounts.map((x) => x.email)).toEqual(['a@exemplo.com'])
    expect(readdirSync(root).some((f) => f.startsWith('antigravity-accounts.json.corrupt-'))).toBe(true)
    expect(existsSync(vaultFile())).toBe(true)
  })
})

describe('agyCredentialIdentity', () => {
  const jwt = (payload: object): string => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'x'].join('.')

  it('lê o e-mail do formato do agy 1.5.13 (id_token_email)', () => {
    expect(agyCredentialIdentity(credential('b'))).toEqual({ id: 'b@exemplo.com', email: 'b@exemplo.com' })
  })

  it('lê o e-mail do formato do agy 1.5.9 (id_token inteiro)', () => {
    const raw = JSON.stringify({ token: { access_token: 'x', refresh_token: 'y' }, id_token: jwt({ email: 'Velho@Exemplo.com' }) })
    expect(agyCredentialIdentity(raw)).toEqual({ id: 'velho@exemplo.com', email: 'Velho@Exemplo.com' })
  })

  it('recusa credencial sem refresh_token: ela não sobrevive fora do agy', () => {
    expect(agyCredentialIdentity(JSON.stringify({ token: { access_token: 'x' }, id_token_email: 'a@exemplo.com' }))).toBeNull()
    expect(agyCredentialIdentity('não é json')).toBeNull()
  })
})
