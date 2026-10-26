import { afterEach, describe, expect, it } from 'vitest'
import { createIdentity } from '../src/main/remote/identity'
import { RelayLink } from '../src/main/remote/link'

// Contra o relay publicado (EasyPanel), passando pelo proxy de lá. Fora do caminho normal: só roda com KORA_SYNC_URL no
// ambiente. Confere o que não depende de conta: o relay não revela nada e recusa quem não está registrado.
const url = process.env['KORA_SYNC_URL']
const closers: (() => void)[] = []
afterEach(() => { while (closers.length) closers.pop()!() })

const until = async (check: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('a condição não aconteceu a tempo')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!url)('relay publicado', () => {
  it('não revela nada a quem vasculha e recusa PC sem conta, com o motivo', async () => {
    const https = url!.replace(/^wss:/, 'https:')
    for (const path of ['/', '/health', '/c/x', '/s/x', '/a/entrar']) {
      const response = await fetch(`${https}${path}`)
      expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 404, body: '' })
    }
    const link = new RelayLink({ url: url!, identity: createIdentity('Intruso'), accepts: () => true, deliver: () => {}, minDelayMs: 60_000 })
    closers.push(() => link.stop())
    link.start()
    await until(() => link.status.error?.includes('conta ativa') === true, 15_000)
  }, 40_000)
})
