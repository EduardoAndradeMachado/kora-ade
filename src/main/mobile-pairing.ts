import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

const DeviceSchema = z.object({ id: z.string(), name: z.string(), pairedAt: z.string(), hash: z.string() })
const ConfigSchema = z.object({ enabled: z.boolean(), devices: z.array(DeviceSchema).max(20) })
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const equal = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const deviceName = (name: string): string => name.trim().slice(0, 60) || 'Celular'

export class MobilePairingStore {
  private config: z.infer<typeof ConfigSchema>
  private invitation: { code: string; until: number } | null = null

  constructor(private readonly file: string) {
    this.config = existsSync(file) ? ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { enabled: false, devices: [] }
  }

  get enabled(): boolean { return this.config.enabled }
  get devices(): { id: string; name: string; pairedAt: string }[] {
    return this.config.devices.map(({ id, name, pairedAt }) => ({ id, name, pairedAt }))
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

  pair(code: string, name: string): string {
    if (!this.invitation || Date.now() > this.invitation.until || !equal(code, this.invitation.code)) {
      throw new Error('QR expirado ou já utilizado. Gere outro no PC.')
    }
    if (this.config.devices.length >= 20) throw new Error('Remova um dispositivo antes de parear outro.')
    this.invitation = null
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    this.config.devices.push({ id, name: deviceName(name), pairedAt: new Date().toISOString(), hash: digest(secret) })
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
