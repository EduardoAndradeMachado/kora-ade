import type { AddressInfo } from 'node:net'
import { createRelay } from './relay.ts'

// Configuração pelo ambiente (EasyPanel):
//   RELAY_TOKEN   segredo que o Kora do PC apresenta para entrar; obrigatório, com 32 caracteres ou mais
//   HEALTH_PATH   caminho do health check (ex.: /saude-<aleatório>); obrigatório, para conferir o deploy
//   TRUST_PROXY   1 quando há proxy na frente (EasyPanel), para bloquear pelo IP de quem pediu e não pelo do proxy
//   PORT          porta interna (8080 por padrão)
const token = process.env['RELAY_TOKEN'] ?? ''
const healthPath = process.env['HEALTH_PATH'] ?? ''
if (token.length < 32) {
  console.error('RELAY_TOKEN ausente ou curto: use 32 caracteres ou mais.')
  process.exit(1)
}
if (!/^\/[\w-]{8,}$/.test(healthPath)) {
  console.error('HEALTH_PATH ausente ou previsível: use algo como /saude-<8+ caracteres aleatórios>.')
  process.exit(1)
}

const port = Number(process.env['PORT'] ?? 8080)
const server = createRelay({ token, healthPath, trustProxy: process.env['TRUST_PROXY'] === '1' })
server.listen(port, () => console.log(`relay no ar na porta ${(server.address() as AddressInfo).port}`))

// O EasyPanel manda SIGTERM no redeploy: fecha as conexões e sai; PC e celular reconectam sozinhos.
process.on('SIGTERM', () => server.close(() => process.exit(0)))
