import type { AddressInfo } from 'node:net'
import { Accounts } from './accounts.ts'
import { connect, migrate } from './db.ts'
import { resendMailer } from './mailer.ts'
import { createRelay } from './relay.ts'
import { RelayService } from './service.ts'

// Configuração pelo ambiente (EasyPanel):
//   DATABASE_URL    Postgres com o schema kora_sync (usuário próprio, ver bootstrap.sql); obrigatório
//   CODE_SECRET     segredo do HMAC dos códigos de e-mail; 32 caracteres ou mais
//   RESEND_API_KEY  chave do Resend para mandar os códigos
//   EMAIL_FROM      remetente, ex.: Kora <noreply@eduardom.com.br>
//   EMAIL_LOGO_URL  endereço público do logotipo em PNG usado nos e-mails
//   HEALTH_PATH     caminho do health check (ex.: /saude-<aleatório>); obrigatório, para conferir o deploy
//   TRUST_PROXY     1 quando há proxy na frente (EasyPanel), para bloquear pelo IP de quem pediu e não pelo do proxy
//   PORT            porta interna (8080 por padrão)
const env = (name: string): string => process.env[name] ?? ''
const problems = [
  !env('DATABASE_URL') && 'DATABASE_URL ausente.',
  env('CODE_SECRET').length < 32 && 'CODE_SECRET ausente ou curto: use 32 caracteres ou mais.',
  !env('RESEND_API_KEY') && 'RESEND_API_KEY ausente.',
  !/<[^@\s]+@[^>\s]+>$|^[^@\s]+@[^@\s]+$/.test(env('EMAIL_FROM')) && 'EMAIL_FROM ausente, ex.: Kora <noreply@exemplo.com>.',
  !/^https:\/\//.test(env('EMAIL_LOGO_URL')) && 'EMAIL_LOGO_URL ausente: endereço https do logotipo em PNG.',
  !/^\/[\w-]{8,}$/.test(env('HEALTH_PATH')) && 'HEALTH_PATH ausente ou previsível: use algo como /saude-<8+ caracteres aleatórios>.'
].filter(Boolean)
if (problems.length) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

const sql = connect(env('DATABASE_URL'))
await migrate(sql)
const accounts = new Accounts(sql, resendMailer(env('RESEND_API_KEY'), env('EMAIL_FROM')), { codeSecret: env('CODE_SECRET'), logoUrl: env('EMAIL_LOGO_URL') })
const service = new RelayService({ sql, accounts })
const server = createRelay({
  directory: service.directory,
  usage: service.usage,
  seen: service.seen,
  request: service.request,
  api: service.api,
  healthPath: env('HEALTH_PATH'),
  trustProxy: env('TRUST_PROXY') === '1'
})
service.relay = server
service.start()
const port = Number(env('PORT') || 8080)
server.listen(port, () => console.log(`relay no ar na porta ${(server.address() as AddressInfo).port}`))

// O EasyPanel manda SIGTERM no redeploy: fecha as conexões (que somam os últimos segundos de consumo), grava o que
// ficou na fila e sai; PC e celular reconectam.
process.on('SIGTERM', () => {
  server.close(() => void service.stop().finally(() => void sql.end({ timeout: 5 }).finally(() => process.exit(0))))
})
