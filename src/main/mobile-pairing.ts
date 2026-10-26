import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { createIdentity, fingerprintOf, type Identity } from './remote/identity'

const FINGERPRINT = /^[0-9a-f]{64}$/
// certificate: impressão digital do certificado do app (Keystore). É ela que autoriza o celular quando ele chega pelo
// relay, onde não há cookie: quem apresenta esse certificado no aperto de mãos é este celular.
const DeviceSchema = z.object({ id: z.string(), name: z.string(), pairedAt: z.string(), hash: z.string(), certificate: z.string().regex(FINGERPRINT).optional() })
// serverId: identidade desta instalação do Kora (o instalado e o Dev têm pastas de dados diferentes). O celular
// guarda um pareamento por id, e os dois Kora do mesmo PC convivem pareados no mesmo celular.
// identity: a chave e o certificado deste Kora no envelope do relay; criados uma vez e guardados, para o ID não mudar.
// remote: "Fora de casa" ligado e o código de convite do relay (o token que o relay pede ao PC).
const ConfigSchema = z.object({
  enabled: z.boolean(),
  devices: z.array(DeviceSchema).max(20),
  serverId: z.string().regex(/^[\w-]{8,32}$/).optional(),
  identity: z.object({ key: z.string(), cert: z.string() }).optional(),
  remote: z.object({ enabled: z.boolean(), invite: z.string() }).optional()
})
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const equal = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const deviceName = (name: string): string => name.trim().slice(0, 60) || 'Celular'

export class MobilePairingStore {
  private config: z.infer<typeof ConfigSchema>
  private invitation: { code: string; until: number } | null = null

  constructor(private readonly file: string) {
    this.config = existsSync(file) ? ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { enabled: false, devices: [] }
    if (!this.config.serverId) {
      this.config.serverId = randomBytes(9).toString('base64url')
      this.save()
    }
  }

  get serverId(): string { return this.config.serverId! }

  identity(): Identity {
    if (!this.config.identity) {
      const { key, cert } = createIdentity(`Kora ${this.serverId}`)
      this.config.identity = { key, cert }
      this.save()
    }
    return { ...this.config.identity, fingerprint: fingerprintOf(this.config.identity.cert) }
  }

  get remote(): { enabled: boolean; invite: string } { return this.config.remote ?? { enabled: false, invite: '' } }

  setRemote(enabled: boolean, invite = this.remote.invite): void {
    this.config.remote = { enabled, invite }
    this.save()
  }

  // Enquanto o QR está valendo, o PC aceita o aperto de mãos de um certificado novo: é o celular que vai parear.
  get pairingOpen(): boolean { return this.invitation !== null && Date.now() <= this.invitation.until }

  // Pelo pareamento antigo (cookie da rede local) o certificado entra uma vez só: quem pegasse o cookie na rede de casa
  // não consegue trocar o do celular pelo dele e ganhar acesso de fora. Trocar de aparelho é parear de novo pelo QR.
  setCertificate(id: string, certificate: string): void {
    if (!FINGERPRINT.test(certificate)) throw new Error('Certificado inválido.')
    const device = this.config.devices.find((d) => d.id === id)
    if (!device) throw new Error('Este celular não está mais vinculado.')
    if (device.certificate === certificate) return
    if (device.certificate) throw new Error('Este celular já tem outro certificado. Para trocar, pareie de novo pelo QR.')
    if (this.config.devices.some((other) => other.certificate === certificate)) throw new Error('Este certificado já é de outro celular.')
    device.certificate = certificate
    this.save()
  }

  deviceByCertificate(fingerprint: string): string | null {
    return this.config.devices.find((device) => device.certificate === fingerprint)?.id ?? null
  }

  get enabled(): boolean { return this.config.enabled }
  get devices(): { id: string; name: string; pairedAt: string; ready: boolean }[] {
    return this.config.devices.map(({ id, name, pairedAt, certificate }) => ({ id, name, pairedAt, ready: certificate !== undefined }))
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    if (!enabled) this.invitation = null
    this.save()
  }

  invite(): { code: string; until: number } {
    this.invitation = { code: randomBytes(32).toString('base64url'), until: Date.now() + 120_000 }
    return this.invitation
  }

  pair(code: string, name: string, certificate?: string): string {
    if (!this.invitation || Date.now() > this.invitation.until || !equal(code, this.invitation.code)) {
      throw new Error('QR expirado ou já utilizado. Gere outro no PC.')
    }
    if (this.config.devices.length >= 20) throw new Error('Remova um dispositivo antes de parear outro.')
    this.invitation = null
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const known = certificate !== undefined && FINGERPRINT.test(certificate) ? certificate : undefined
    // Parear de novo o mesmo app (mesmo certificado) substitui o pareamento antigo em vez de duplicar o celular.
    if (known) this.config.devices = this.config.devices.filter((device) => device.certificate !== known)
    this.config.devices.push({ id, name: deviceName(name), pairedAt: new Date().toISOString(), hash: digest(secret), ...(known ? { certificate: known } : {}) })
    this.save()
    return `${id}.${secret}`
  }

  rename(id: string, name: string): void {
    const device = this.config.devices.find((d) => d.id === id)
    if (!device) throw new Error('Este celular não está mais vinculado.')
    device.name = deviceName(name)
    this.save()
  }

  authenticate(token: string): string | null {
    const [id, secret] = token.split('.')
    const device = this.config.devices.find((d) => d.id === id)
    return device && secret && equal(device.hash, digest(secret)) ? device.id : null
  }

  revoke(id: string): void {
    this.config.devices = this.config.devices.filter((d) => d.id !== id)
    this.save()
  }

  private save(): void { writeFileSync(this.file, JSON.stringify(this.config, null, 2), 'utf8') }
}
