import { readFile, rename } from 'node:fs/promises'
import { z } from 'zod'
import type { AntigravityAccountsView } from '../shared/antigravity-accounts'
import type { AgyCredentialStore } from './antigravity'
import { writeJsonAtomic, type Secrets } from './claude-accounts'
import { antigravityCredentialEmail } from './usage'

// O refresh_token é o que mantém a conta viva fora do agy: o access_token vence em 1 h e o agy renova sozinho ao abrir.
const CredentialSchema = z.looseObject({
  token: z.looseObject({ refresh_token: z.string().min(1) }),
  id_token: z.string().nullish(),
  id_token_email: z.string().nullish()
})

const StoredSchema = z.object({ id: z.string().min(1), email: z.string().min(1), secret: z.string().min(1) })
type Stored = z.infer<typeof StoredSchema>

const VaultSchema = z.object({ version: z.literal(1), accounts: z.array(StoredSchema) })
type Vault = z.infer<typeof VaultSchema>

export interface AntigravityAccountsDeps {
  store: AgyCredentialStore
  vaultFile: string
  secrets: Secrets
  // Quantos agy.exe estão rodando no computador, dentro ou fora do Kora.
  runningAgy(): number
  now?: () => number
  onChange?: () => void
  // A conta ativa do agy mudou (troca, conta nova ou login feito no próprio agy): a cota guardada era da anterior.
  onActiveChange?: () => void
}

/** E-mail da credencial crua do agy; null quando não é uma credencial que o Kora saiba guardar. */
export function agyCredentialIdentity(raw: string): { id: string; email: string } | null {
  let parsed: z.infer<typeof CredentialSchema>
  try {
    const result = CredentialSchema.safeParse(JSON.parse(raw))
    if (!result.success) return null
    parsed = result.data
  } catch {
    return null
  }
  const email = antigravityCredentialEmail(parsed)
  return email ? { id: email.toLowerCase(), email } : null
}

export class AntigravityAccounts {
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  // Conta que estava ativa quando o Kora tirou o login para outra entrar; volta se o login for cancelado.
  private adding: { previousId: string | null } | null = null
  private lastActiveId: string | null | undefined = undefined
  private lastSignature = ''
  private savedCount = 0

  constructor(private readonly deps: AntigravityAccountsDeps) {
    this.now = deps.now ?? Date.now
  }

  // O cofre e a credencial do agy só mudam um passo por vez: a sincronização periódica não pode cair no meio de uma troca.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private async loadVault(): Promise<Vault> {
    let raw: string
    try {
      raw = await readFile(this.deps.vaultFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] }
      throw err
    }
    let parsed: Vault | null = null
    try {
      parsed = VaultSchema.parse(JSON.parse(raw))
    } catch {
      // Cofre ilegível não pode travar a troca para sempre nem ser sobrescrito: fica guardado ao lado.
      await rename(this.deps.vaultFile, `${this.deps.vaultFile}.corrupt-${this.now()}`)
    }
    return parsed ?? { version: 1, accounts: [] }
  }

  private secretOf(stored: Stored): string {
    return this.deps.secrets.decrypt(stored.secret)
  }

  // true quando o cofre mudou e precisa ser gravado.
  private upsert(vault: Vault, identity: { id: string; email: string }, raw: string): boolean {
    const index = vault.accounts.findIndex((a) => a.id === identity.id)
    if (index >= 0) {
      let saved: string | null = null
      try {
        saved = this.secretOf(vault.accounts[index]!)
      } catch {
        // Segredo que não abre mais (outro usuário do Windows, cofre copiado de outra máquina): é substituído.
      }
      if (saved === raw) return false
    }
    const stored: Stored = { id: identity.id, email: identity.email, secret: this.deps.secrets.encrypt(raw) }
    if (index >= 0) vault.accounts[index] = stored
    else vault.accounts.push(stored)
    return true
  }

  private view(vault: Vault, activeId: string | null, activeUnknown: boolean): AntigravityAccountsView {
    this.savedCount = vault.accounts.length
    if (activeId !== this.lastActiveId) {
      const changed = this.lastActiveId !== undefined
      this.lastActiveId = activeId
      if (changed) this.deps.onActiveChange?.()
    }
    return {
      accounts: vault.accounts.map((a) => ({ id: a.id, email: a.email, active: a.id === activeId })),
      activeUnknown,
      adding: this.adding !== null
    }
  }

  // Guarda no cofre o login atual do agy (o primeiro vira conta sem precisar adicionar) e a versão mais nova dele,
  // que o agy regrava a cada renovação.
  private async syncNow(): Promise<AntigravityAccountsView> {
    const vault = await this.loadVault()
    const raw = this.deps.store.read()
    if (raw === null) return this.view(vault, null, false)
    // O login que o agy gravou depois de o Kora esvaziar a credencial é a conta nova, reconhecida ou não.
    if (this.adding) {
      this.adding = null
      this.deps.onChange?.()
    }
    const identity = agyCredentialIdentity(raw)
    if (!identity) return this.view(vault, null, true)
    if (this.upsert(vault, identity, raw)) await writeJsonAtomic(this.deps.vaultFile, vault)
    return this.view(vault, identity.id, false)
  }

  // A conta que sai vai para o cofre antes de a credencial mudar: se a gravação falhar depois, nada se perde.
  private async saveCurrent(vault: Vault): Promise<string | null> {
    const raw = this.deps.store.read()
    if (raw === null) return null
    const identity = agyCredentialIdentity(raw)
    if (!identity) throw new Error('Não reconheci a conta logada agora no agy; ela seria perdida na troca')
    if (this.upsert(vault, identity, raw)) await writeJsonAtomic(this.deps.vaultFile, vault)
    return identity.id
  }

  private assertAgyClosed(): void {
    const running = this.deps.runningAgy()
    if (running > 0) {
      throw new Error(
        running === 1
          ? 'Feche o agy antes de trocar a conta: o agy aberto continuaria na conta atual'
          : `Feche os ${running} agy abertos antes de trocar a conta: eles continuariam na conta atual`
      )
    }
  }

  /** Síncrono para a leitura de cota: vale o que a última sincronização viu. */
  hasSavedAccounts(): boolean {
    return this.savedCount > 0
  }

  list(): Promise<AntigravityAccountsView> {
    return this.serial(() => this.syncNow())
  }

  /** Para a verificação periódica: true quando algo visível mudou desde a última vez. */
  async sync(): Promise<boolean> {
    const signature = JSON.stringify(await this.list())
    if (signature === this.lastSignature) return false
    this.lastSignature = signature
    return true
  }

  /** Troca o login do agy do computador todo; o próximo agy que abrir já entra na conta escolhida. */
  switchTo(id: string): Promise<AntigravityAccountsView> {
    return this.serial(async () => {
      this.assertAgyClosed()
      const vault = await this.loadVault()
      const target = vault.accounts.find((a) => a.id === id)
      if (!target) throw new Error('Conta não encontrada no Kora')
      const targetRaw = this.secretOf(target)
      const currentId = await this.saveCurrent(vault)
      // De novo: um agy pode ter aberto (pelo celular, por exemplo) durante as leituras acima.
      this.assertAgyClosed()
      if (currentId !== id) this.deps.store.write(targetRaw)
      this.adding = null
      return this.view(vault, id, false)
    })
  }

  remove(id: string): Promise<AntigravityAccountsView> {
    return this.serial(async () => {
      const view = await this.syncNow()
      if (view.accounts.some((a) => a.id === id && a.active)) {
        throw new Error('A conta em uso não pode ser removida; troque para outra antes')
      }
      // Durante a conta nova o login dela só existe aqui; é ela que volta se a conta nova for cancelada.
      if (this.adding?.previousId === id) {
        throw new Error('Essa conta volta se a conta nova for cancelada; termine ou cancele antes de removê-la')
      }
      const vault = await this.loadVault()
      vault.accounts = vault.accounts.filter((a) => a.id !== id)
      await writeJsonAtomic(this.deps.vaultFile, vault)
      return this.view(vault, view.accounts.find((a) => a.active)?.id ?? null, view.activeUnknown)
    })
  }

  /**
   * Guarda a conta atual e tira o login do agy, para o próximo agy aberto pedir login de outra conta. O /logout do
   * agy não serve: ele pode revogar o login no Google e invalidar a cópia guardada.
   */
  startAdding(): Promise<AntigravityAccountsView> {
    return this.serial(async () => {
      this.assertAgyClosed()
      const vault = await this.loadVault()
      const previousId = await this.saveCurrent(vault)
      this.assertAgyClosed()
      this.deps.store.remove()
      this.adding = { previousId }
      return this.view(vault, null, false)
    })
  }

  /** Desiste da conta nova: se o agy ainda não gravou login nenhum, a conta anterior volta. */
  cancelAdding(): Promise<AntigravityAccountsView> {
    return this.serial(async () => {
      this.assertAgyClosed()
      const vault = await this.loadVault()
      const previousId = this.adding?.previousId
      const previous = previousId ? vault.accounts.find((a) => a.id === previousId) : undefined
      // Se a gravação falhar, a espera continua e o Cancelar pode tentar de novo.
      if (previous && this.deps.store.read() === null) this.deps.store.write(this.secretOf(previous))
      this.adding = null
      return this.syncNow()
    })
  }
}
