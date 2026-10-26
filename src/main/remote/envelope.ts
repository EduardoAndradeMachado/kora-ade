import { connect, createSecureContext, TLSSocket, type PeerCertificate } from 'node:tls'
import type { Duplex } from 'node:stream'
import type { Identity } from './identity'

// O envelope de dentro: TLS 1.3 entre o celular e o PC, por cima de qualquer transporte (o WebSocket do relay).
// Cada lado confere a impressão digital do outro e ignora cadeia e validade: a confiança vem do pareamento, não de uma CA.
const HANDSHAKE_MS = 15_000

const fingerprint = (peer: PeerCertificate): string | null => peer.fingerprint256 ? peer.fingerprint256.replaceAll(':', '').toLowerCase() : null

// O ID do outro lado de um envelope já aberto (o certificado que ele apresentou no aperto de mãos).
export const peerFingerprint = (socket: TLSSocket): string | null => fingerprint(socket.getPeerCertificate())

// O TLS do Node não percebe sozinho quando o transporte de baixo fecha, nem o fecha quando ele mesmo é destruído: sem
// amarrar os dois, um lado ficaria esperando para sempre uma conexão que o outro já largou.
function bind(transport: Duplex, socket: TLSSocket): void {
  // O fluxo do WebSocket que fechou só emite 'end' (fica meio aberto esperando a escrita): os dois avisos valem.
  transport.once('end', () => socket.destroy())
  transport.once('close', () => socket.destroy())
  socket.once('close', () => transport.destroy())
}

function settle(socket: TLSSocket, event: 'secure' | 'secureConnect', check: () => boolean): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('O aperto de mãos com o outro lado não terminou a tempo.')), HANDSHAKE_MS)
    const fail = (error: Error): void => { clearTimeout(timer); socket.destroy(); reject(error) }
    socket.once('error', fail)
    socket.once(event, () => {
      clearTimeout(timer)
      socket.off('error', fail)
      if (check()) resolve(socket)
      else fail(new Error('O certificado do outro lado não é o do pareamento.'))
    })
  })
}

// Lado do PC: só aceita o celular cujo certificado foi registrado no pareamento.
export function openEnvelope(transport: Duplex, me: Identity, accepts: (fingerprint: string) => boolean): Promise<TLSSocket> {
  const socket = new TLSSocket(transport, {
    isServer: true,
    secureContext: createSecureContext({ key: me.key, cert: me.cert, minVersion: 'TLSv1.3' }),
    requestCert: true,
    rejectUnauthorized: false
  })
  bind(transport, socket)
  return settle(socket, 'secure', () => {
    const peer = fingerprint(socket.getPeerCertificate())
    return peer !== null && accepts(peer)
  })
}

// Lado do celular: só fala com o PC cujo certificado veio no QR. Nada é escrito antes dessa conferência.
export function sealEnvelope(transport: Duplex, me: Identity, expected: string): Promise<TLSSocket> {
  const socket = connect({ socket: transport, key: me.key, cert: me.cert, minVersion: 'TLSv1.3', rejectUnauthorized: false })
  bind(transport, socket)
  return settle(socket, 'secureConnect', () => fingerprint(socket.getPeerCertificate()) === expected)
}
