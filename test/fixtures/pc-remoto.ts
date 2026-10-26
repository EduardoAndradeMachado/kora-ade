import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, createWebSocketStream } from 'ws'
import { createRelay } from '../../relay/relay.ts'
import { createIdentity } from '../../src/main/remote/identity.ts'
import { openEnvelope } from '../../src/main/remote/envelope.ts'

// Relay e PC de verdade (o mesmo código do Kora) para o teste do app Android (EnvelopeTest.kt) conversar com eles.
// Escreve numa linha o endereço e as identidades; termina quando a entrada padrão fecha.
const token = 'token-do-teste-android'
const pc = createIdentity('PC')
const celular = createIdentity('Celular pareado')
const estranho = createIdentity('Celular estranho')

const app = createServer((request, response) => {
  if (request.url === '/eco') return void response.end(`eco do PC para ${request.headers['x-quem'] ?? 'alguém'}`)
  response.writeHead(404).end()
})
const relay = createRelay({ token })
relay.listen(0, '127.0.0.1', () => {
  const port = (relay.address() as AddressInfo).port
  const control = new WebSocket(`ws://127.0.0.1:${port}/s/${pc.fingerprint}`, { headers: { authorization: `Bearer ${token}` } })
  control.on('message', (message) => {
    const { sessao } = JSON.parse(String(message)) as { sessao: string }
    const data = new WebSocket(`ws://127.0.0.1:${port}/s/${pc.fingerprint}/${sessao}`, { headers: { authorization: `Bearer ${token}` } })
    openEnvelope(createWebSocketStream(data), pc, (fingerprint) => fingerprint === celular.fingerprint)
      .then((socket) => { app.emit('connection', socket) }, () => {})
  })
  control.on('open', () => {
    process.stdout.write(`${JSON.stringify({ porta: port, pc: pc.fingerprint, celular, estranho })}\n`)
  })
})
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
