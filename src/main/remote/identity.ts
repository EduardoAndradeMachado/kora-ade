import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'

// Identidade de um aparelho: um par de chaves ECDSA P-256 (o mesmo tipo que o Keystore do Android gera para o celular,
// para os dois lados do TLS casarem) e um certificado autoassinado que só serve de embalagem para a chave pública.
export interface Identity { key: string; cert: string; fingerprint: string }

const DAY = 86_400_000

// O ID de cada aparelho é a impressão digital do certificado (como no Syncthing): quem conhece o ID confere o certificado.
export const fingerprintOf = (cert: string | Buffer): string => new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase()

// DER mínimo de um certificado X.509 v1. Toda a criptografia vem do OpenSSL (gerar a chave, exportá-la e assinar); aqui
// só se empacota. A confiança vem da impressão digital, não do conteúdo: um certificado malformado é recusado pelo TLS.
const lengthOf = (size: number): Buffer => {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body])
}
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts)
const ECDSA_WITH_SHA256 = sequence(Buffer.from('06082a8648ce3d040302', 'hex'))
const COMMON_NAME = Buffer.from('0603550403', 'hex')
const name = (text: string): Buffer => sequence(tlv(0x31, sequence(COMMON_NAME, tlv(0x0c, Buffer.from(text, 'utf8')))))
// UTCTime até 2049 e GeneralizedTime a partir de 2050, como manda a RFC 5280.
const time = (date: Date): Buffer => {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), 'ascii')) : tlv(0x18, Buffer.from(iso, 'ascii'))
}

export function createIdentity(label: string): Identity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const serial = randomBytes(16)
  serial[0] = serial[0]! & 0x7f
  const now = Date.now()
  const tbs = sequence(
    tlv(0x02, serial),
    ECDSA_WITH_SHA256,
    name(label),
    // A validade nunca é conferida, só a impressão digital: o pareamento não expira. Longa só para ninguém estranhar.
    sequence(time(new Date(now - DAY)), time(new Date(now + 100 * 365 * DAY))),
    name(label),
    publicKey.export({ type: 'spki', format: 'der' })
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), signature))
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert, fingerprint: fingerprintOf(cert) }
}
