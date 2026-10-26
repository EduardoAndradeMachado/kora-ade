import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { createServer } from 'node:net'

// Postgres de verdade (PGlite, compilado para WebAssembly) atrás de um socket local: o teste usa o mesmo driver e o
// mesmo SQL de produção, sem Docker. Um banco novo por chamada.
export async function startTestDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const db = await PGlite.create()
  const port = await freePort()
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 })
  await server.start()
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async close() {
      await server.stop()
      await db.close()
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}
