import { createServer, request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, createWebSocketStream } from 'ws'
import { createIdentity } from '../src/main/remote/identity'
import { sealEnvelope } from '../src/main/remote/envelope'
import { RelayLink } from '../src/main/remote/link'

// Contra o relay publicado (EasyPanel), passando pelo proxy de lá. Fora do caminho normal: só roda com KORA_SYNC_URL e
// KORA_SYNC_TOKEN no ambiente, que ficam no infra.secrets.env do Eduardo e nunca no repositório.
const url = process.env['KORA_SYNC_URL']
const token = process.env['KORA_SYNC_TOKEN']
const closers: (() => void)[] = []
afterEach(() => { while (closers.length) closers.pop()!() })

const until = async (check: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('a condição não aconteceu a tempo')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!url || !token)('relay publicado', () => {
  it('liga um celular pareado ao PC pelo relay real, cifrado de ponta a ponta', async () => {
    const [pc, phone] = [createIdentity('PC de teste'), createIdentity('Celular de teste')]
    const app = createServer((_req, res) => res.end('PC alcançado pelo relay publicado'))
    const link = new RelayLink({ url: url!, token: token!, identity: pc, accepts: (fingerprint) => fingerprint === phone.fingerprint, deliver: (socket) => app.emit('connection', socket) })
    closers.push(() => link.stop())
    link.start()
    await until(() => link.status.state === 'conectado', 15_000)
    const ws = new WebSocket(`${url}/c/${pc.fingerprint}`)
    closers.push(() => ws.terminate())
    const socket = await sealEnvelope(createWebSocketStream(ws), phone, pc.fingerprint)
    const body = await new Promise<string>((resolve, reject) => {
      request({ createConnection: () => socket, path: '/' }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve(text))
      }).on('error', reject).end()
    })
    expect(body).toBe('PC alcançado pelo relay publicado')
  }, 40_000)

  it('não revela nada a quem vasculha e recusa PC sem o convite', async () => {
    const https = url!.replace(/^wss:/, 'https:')
    for (const path of ['/', '/health', '/c/x', '/s/x']) {
      const response = await fetch(`${https}${path}`)
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 404, body: '' })
    }
    const link = new RelayLink({ url: url!, token: 'convite-inventado', identity: createIdentity('Intruso'), accepts: () => true, deliver: () => {}, minDelayMs: 60_000 })
    closers.push(() => link.stop())
    link.start()
    await until(() => link.status.error?.includes('código de convite') === true, 15_000)
  }, 40_000)
})
