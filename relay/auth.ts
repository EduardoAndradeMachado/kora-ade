import { X509Certificate, createPrivateKey, sign, verify } from 'node:crypto'

// Prova de posse da chave em cada conexão ao relay, em dois cabeçalhos:
//   Authorization:      Kora <impressão digital>.<instante em ms>.<assinatura ECDSA-SHA256 em base64url>
//   X-Kora-Certificate: o certificado em DER, base64
// A assinatura cobre "kora-relay:<caminho>:<instante>" e vale por 2 minutos; a impressão digital é o SHA-256 do
// certificado, então quem assina com a chave dele é quem o banco registrou. O app Android monta o mesmo formato
// (Relay.kt): mudar aqui é mudar lá.
export const AUTH_WINDOW_MS = 120_000

export interface RelayAuth { fingerprint: string; at: number; signature: Buffer; certificate: Buffer }

const message = (path: string, at: number): Buffer => Buffer.from(`kora-relay:${path}:${at}`)

export function relayHeaders(identity: { key: string; cert: string; fingerprint: string }, path: string, now = Date.now()): Record<string, string> {
  const signature = sign('sha256', message(path, now), createPrivateKey(identity.key))
  return {
    authorization: `Kora ${identity.fingerprint}.${now}.${signature.toString('base64url')}`,
    'x-kora-certificate': new X509Certificate(identity.cert).raw.toString('base64')
  }
}

export function parseRelayAuth(authorization: string | undefined, certificate: string | undefined): RelayAuth | null {
  const match = /^Kora ([0-9a-f]{64})\.(\d{13})\.([A-Za-z0-9_-]{40,200})$/.exec(authorization ?? '')
  if (!match || !certificate || certificate.length > 4096 || !/^[A-Za-z0-9+/]+=*$/.test(certificate)) return null
  return { fingerprint: match[1]!, at: Number(match[2]), signature: Buffer.from(match[3]!, 'base64url'), certificate: Buffer.from(certificate, 'base64') }
}

// Certificado com outra impressão digital, assinatura de outro caminho ou malformada: 'invalid'. Assinatura certa fora
// dos 2 minutos: 'stale', que é quase sempre o relógio do aparelho errado, e não deve ser tratada como invasão.
export function checkRelayAuth(auth: RelayAuth, path: string, now = Date.now()): 'ok' | 'stale' | 'invalid' {
  try {
    const certificate = new X509Certificate(auth.certificate)
    if (certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== auth.fingerprint) return 'invalid'
    if (!verify('sha256', message(path, auth.at), certificate.publicKey, auth.signature)) return 'invalid'
    return Math.abs(now - auth.at) > AUTH_WINDOW_MS ? 'stale' : 'ok'
  } catch {
    return 'invalid'
  }
}

export const verifyRelayAuth = (auth: RelayAuth, path: string, now = Date.now()): boolean => checkRelayAuth(auth, path, now) === 'ok'
