import type { AddressInfo } from 'node:net'
import { test, expect } from './harness'
import { Accounts } from '../relay/accounts'
import { connect, migrate } from '../relay/db'
import type { Email } from '../relay/emails'
import { createRelay } from '../relay/relay'
import { RelayService } from '../relay/service'
import { startTestDatabase } from '../relay/testing/pg'

// Relay com Postgres de verdade (PGlite) dentro do teste, e o Kora apontado para ele: o caminho inteiro da conta, da
// tela do PC até o banco. Os e-mails ficam numa caixa de mentira, de onde o teste lê o código.
async function relayWithDatabase(): Promise<{ url: string; sent: { to: string; email: Email }[]; sql: ReturnType<typeof connect>; close(): Promise<void> }> {
  const database = await startTestDatabase()
  const sql = connect(database.url)
  await sql`create schema kora_sync`
  await migrate(sql)
  const sent: { to: string; email: Email }[] = []
  const accounts = new Accounts(sql, { send: async (to, email) => { sent.push({ to, email }) } }, { codeSecret: 'segredo-do-e2e', logoUrl: 'https://exemplo/logo.png' })
  const service = new RelayService({ sql, accounts })
  const relay = createRelay({ directory: service.directory, usage: service.usage, seen: service.seen, request: service.request, api: service.api })
  service.relay = relay
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  return {
    url: `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    sent,
    sql,
    async close() {
      await new Promise((resolve) => relay.close(resolve))
      await sql.end()
      await database.close()
    }
  }
}

test('R-conta Fora de casa: cria a conta pelo painel do celular, liga, e o dono do servidor vê o painel e bloqueia', async ({ kora }) => {
  test.setTimeout(240_000)
  const relay = await relayWithDatabase()
  try {
    const run = await kora.launch({ ...kora.env(), relayUrl: relay.url })
    const page = run.page
    await page.getByRole('button', { name: 'Celular', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Celular' })
    const away = panel.getByRole('switch', { name: 'Fora de casa' })
    await expect(away).toHaveAttribute('aria-checked', 'false')

    // Sem conta, ligar não liga: aparece o aviso para entrar e o formulário logo abaixo.
    await away.click()
    await expect(away).toHaveAttribute('aria-checked', 'false')
    await expect(panel.getByRole('alert')).toContainText('Entre na sua conta do Kora para ligar o acesso fora de casa.')
    await expect(panel.getByRole('form', { name: 'Entrar na conta do Kora' })).toBeVisible()
    await page.screenshot({ path: 'e2e/.results/conta-entrar.png' })

    await panel.getByRole('button', { name: 'Criar conta' }).click()
    await panel.getByLabel('E-mail').fill('Dono@Exemplo.com')
    await panel.getByRole('button', { name: 'Enviar código' }).click()
    await expect(panel.getByRole('form', { name: 'Confirme o e-mail' })).toBeVisible()
    await expect.poll(() => relay.sent.length).toBe(1)
    const code = /(\d{3}) (\d{3})/.exec(relay.sent[0]!.email.text)!
    await page.screenshot({ path: 'e2e/.results/conta-codigo.png' })

    // Código errado: a mensagem do relay aparece e nada liga.
    await panel.getByLabel('Código do e-mail').fill('000000')
    await panel.getByLabel('Nova senha').fill('senha-boa-123')
    await panel.getByRole('button', { name: 'Criar conta e ligar' }).click()
    await expect(panel.getByRole('alert').filter({ hasText: 'Código incorreto ou vencido' })).toBeVisible()

    // Colado como vem no e-mail ("482 913", com espaço e sobra em volta): o campo fica só com os 6 dígitos.
    const field = panel.getByLabel('Código do e-mail')
    await field.fill('')
    await field.focus()
    await page.keyboard.insertText(` ${code[0]} `)
    await expect(field).toHaveValue(code[1]! + code[2]!)
    await panel.getByRole('button', { name: 'Criar conta e ligar' }).click()
    await expect(away).toHaveAttribute('aria-checked', 'true')
    await expect(panel.getByText('No ar: o celular alcança este PC de qualquer rede.')).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByText('dono@exemplo.com')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Painel do servidor' })).toHaveCount(0)
    await page.screenshot({ path: 'e2e/.results/conta-ligada.png' })

    // Só o banco faz alguém admin; o Kora fica sabendo na próxima conexão.
    const other = await relay.sql<{ id: string }[]>`insert into kora_sync.accounts (email, verified_at) values ('outra@exemplo.com', now()) returning id`
    await relay.sql`update kora_sync.accounts set admin = true where email = 'dono@exemplo.com'`
    await away.click()
    await expect(away).toHaveAttribute('aria-checked', 'false')
    await away.click()
    await panel.getByRole('button', { name: 'Painel do servidor' }).click()
    const admin = page.getByRole('dialog', { name: 'Painel do servidor' })
    await expect(admin.getByRole('region', { name: 'dono@exemplo.com' })).toContainText('no ar agora')
    // A conta de quem olha vem à parte, e o PC aparece com sistema e versão (o X-Kora-Client que o Kora manda).
    await expect(admin.getByRole('region', { name: 'dono@exemplo.com' })).toContainText('Sua conta')
    await expect(admin.getByRole('region', { name: 'dono@exemplo.com' })).toContainText(/(windows|win32) .*kora\/0\.0\.0/)
    await expect(admin.getByText('Outras contas')).toBeVisible()
    const target = admin.getByRole('region', { name: 'outra@exemplo.com' })
    await expect(target).toContainText('Nenhum aparelho.')
    await page.screenshot({ path: 'e2e/.results/conta-admin.png' })
    await target.getByRole('button', { name: 'Bloquear' }).click()
    await target.getByLabel('Motivo do bloqueio').fill('teste de bloqueio')
    await page.screenshot({ path: 'e2e/.results/conta-bloquear.png' })
    await target.getByRole('button', { name: 'Confirmar bloqueio' }).click()
    await expect(target).toContainText('bloqueada')
    const [blocked] = await relay.sql<{ blocked_reason: string }[]>`select blocked_reason from kora_sync.accounts where id = ${other[0]!.id}`
    expect(blocked!.blocked_reason).toBe('teste de bloqueio')

    // Na bandeja o Kora continua aberto, e o PC continua no ar pelo servidor do Kora.
    await admin.getByRole('button', { name: 'Fechar' }).click()
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect.poll(() => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
    await page.waitForTimeout(1500)
    expect((await page.evaluate(() => window.kora.mobileStatus())).remote?.state).toBe('conectado')
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    await page.getByRole('button', { name: 'Celular', exact: true }).click()

    // Sair: o relay esquece este PC e o Fora de casa desliga.
    await panel.getByRole('button', { name: 'Sair' }).click()
    await expect(away).toHaveAttribute('aria-checked', 'false')
    await expect(panel.getByRole('form', { name: 'Entrar na conta do Kora' })).toBeVisible()
    await expect.poll(async () => (await relay.sql`select 1 from kora_sync.devices where kind = 'pc'`).length).toBe(0)
  } finally {
    await relay.close()
  }
})
