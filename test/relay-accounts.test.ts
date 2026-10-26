import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Accounts, type Mailer } from '../relay/accounts'
import { connect, migrate, type Sql } from '../relay/db'
import type { Email } from '../relay/emails'
import { startTestDatabase } from '../relay/testing/pg'
import { hashPassword, scryptPeak } from '../relay/passwords'

let database: Awaited<ReturnType<typeof startTestDatabase>>
let sql: Sql
let clock: number
let sent: { to: string; email: Email }[]
let accounts: Accounts

const mailer: Mailer = { send: async (to, email) => { sent.push({ to, email }) } }
const lastCode = (to: string): string => {
  const mail = sent.filter((item) => item.to === to).at(-1)
  const match = /(\d{3}) (\d{3})/.exec(mail?.email.text ?? '')
  if (!match) throw new Error(`nenhum código enviado para ${to}`)
  return match[1]! + match[2]!
}
const wrong = (code: string): string => String((Number(code) + 1) % 1_000_000).padStart(6, '0')
const PASSWORD = 'senha-boa-123'

async function createVerified(email: string, password = PASSWORD): Promise<string> {
  await accounts.signup(email)
  const result = await accounts.verifySignup(email, lastCode(email), password)
  if (!result.ok) throw new Error('verificação falhou')
  return result.accountId
}

beforeAll(async () => {
  database = await startTestDatabase()
  sql = connect(database.url)
  await sql`create schema kora_sync`
  await migrate(sql)
  // Rodar de novo não reaplica nada: é o que acontece a cada reinício do relay.
  await migrate(sql)
}, 60_000)

afterAll(async () => {
  await sql.end()
  await database.close()
})

beforeEach(async () => {
  await sql`truncate kora_sync.accounts cascade`
  clock = Date.parse('2026-10-26T12:00:00Z')
  sent = []
  accounts = new Accounts(sql, mailer, { codeSecret: 'segredo-de-teste', logoUrl: 'https://exemplo/logo.png', now: () => clock })
})

describe('contas do relay', () => {
  it('cadastro: o código chega por e-mail, a senha vale a partir da verificação e o login entra', async () => {
    await accounts.signup('  Pessoa@Exemplo.com ')
    expect(sent.map((item) => [item.to, item.email.subject])).toEqual([['pessoa@exemplo.com', 'Confirme seu e-mail no Kora']])
    expect(await accounts.login('pessoa@exemplo.com', PASSWORD)).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.verifySignup('pessoa@exemplo.com', lastCode('pessoa@exemplo.com'), PASSWORD)).toMatchObject({ ok: true })
    expect(await accounts.login('PESSOA@exemplo.com', PASSWORD)).toMatchObject({ ok: true, admin: false })
  })

  it('quem cadastra o e-mail de outra pessoa não escolhe a senha da conta que ela ativa', async () => {
    // Os dois pedem cadastro; a dona do e-mail digita o código que recebeu, com a senha dela.
    await accounts.signup('vitima@exemplo.com')
    clock += 61_000
    await accounts.signup('vitima@exemplo.com')
    expect(await accounts.verifySignup('vitima@exemplo.com', lastCode('vitima@exemplo.com'), 'senha-da-vitima')).toMatchObject({ ok: true })
    expect(await accounts.login('vitima@exemplo.com', 'senha-do-atacante')).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.login('vitima@exemplo.com', 'senha-da-vitima')).toMatchObject({ ok: true })
  })

  it('cadastro de e-mail que já tem conta não manda nada (e responde igual)', async () => {
    await createVerified('ja@exemplo.com')
    sent = []
    await accounts.signup('ja@exemplo.com')
    expect(sent).toEqual([])
  })

  it('o código morre depois de 5 erros: nem o certo serve mais', async () => {
    await accounts.signup('a@exemplo.com')
    const code = lastCode('a@exemplo.com')
    for (let i = 0; i < 5; i++) expect(await accounts.verifySignup('a@exemplo.com', wrong(code), PASSWORD)).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.verifySignup('a@exemplo.com', code, PASSWORD)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('o código vale 15 minutos e uma vez só', async () => {
    await accounts.signup('b@exemplo.com')
    const code = lastCode('b@exemplo.com')
    clock += 15 * 60_000 + 1
    expect(await accounts.verifySignup('b@exemplo.com', code, PASSWORD)).toEqual({ ok: false, reason: 'invalid' })

    clock += 61_000
    await accounts.signup('b@exemplo.com')
    const fresh = lastCode('b@exemplo.com')
    expect(await accounts.verifySignup('b@exemplo.com', fresh, PASSWORD)).toMatchObject({ ok: true })
    // Quem visse o código depois de usado não regrava a senha com ele.
    expect(await accounts.verifySignup('b@exemplo.com', fresh, 'senha-de-outro')).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.login('b@exemplo.com', PASSWORD)).toMatchObject({ ok: true })
  })

  it('pedir código de novo antes de 1 minuto não manda outro e-mail; depois manda e o antigo deixa de valer', async () => {
    await accounts.signup('c@exemplo.com')
    const first = lastCode('c@exemplo.com')
    await accounts.signup('c@exemplo.com')
    expect(sent).toHaveLength(1)
    clock += 61_000
    await accounts.signup('c@exemplo.com')
    expect(sent).toHaveLength(2)
    const second = lastCode('c@exemplo.com')
    if (second !== first) expect(await accounts.verifySignup('c@exemplo.com', first, PASSWORD)).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.verifySignup('c@exemplo.com', second, PASSWORD)).toMatchObject({ ok: true })
  })

  it('senha errada 5 vezes trava o e-mail 15 minutos naquele IP, mesmo com a senha certa; depois libera', async () => {
    await createVerified('d@exemplo.com')
    for (let i = 0; i < 5; i++) expect(await accounts.login('d@exemplo.com', 'errada-errada', '203.0.113.9')).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.login('d@exemplo.com', PASSWORD, '203.0.113.9')).toEqual({ ok: false, reason: 'locked' })
    // Quem errou de propósito não trava a dona da conta, que entra de outra rede.
    expect(await accounts.login('d@exemplo.com', PASSWORD, '198.51.100.4')).toMatchObject({ ok: true })
    clock += 15 * 60_000 + 1
    expect(await accounts.login('d@exemplo.com', PASSWORD, '203.0.113.9')).toMatchObject({ ok: true })
  })

  it('a trava responde igual para e-mail com e sem conta: errar não revela quem tem conta', async () => {
    await createVerified('existe@exemplo.com')
    for (const email of ['existe@exemplo.com', 'nao-existe@exemplo.com']) {
      for (let i = 0; i < 5; i++) expect(await accounts.login(email, 'errada-errada', '203.0.113.9')).toEqual({ ok: false, reason: 'invalid' })
      expect(await accounts.login(email, 'errada-errada', '203.0.113.9')).toEqual({ ok: false, reason: 'locked' })
    }
  })

  it('pedir código novo não renova as tentativas sem fim: 10 erros num dia matam até o código certo', async () => {
    await createVerified('alvo@exemplo.com')
    for (let round = 0; round < 2; round++) {
      await accounts.requestReset('alvo@exemplo.com')
      const code = lastCode('alvo@exemplo.com')
      for (let i = 0; i < 5; i++) await accounts.confirmReset('alvo@exemplo.com', wrong(code), 'nova-senha-boa')
      clock += 61_000
    }
    await accounts.requestReset('alvo@exemplo.com')
    expect(await accounts.confirmReset('alvo@exemplo.com', lastCode('alvo@exemplo.com'), 'nova-senha-boa')).toEqual({ ok: false, reason: 'invalid' })
    clock += 24 * 60 * 60_000 + 1
    await accounts.requestReset('alvo@exemplo.com')
    expect(await accounts.confirmReset('alvo@exemplo.com', lastCode('alvo@exemplo.com'), 'nova-senha-boa')).toMatchObject({ ok: true })
  })

  it('no máximo 5 códigos por hora por conta: ninguém usa o relay para encher a caixa de alguém', async () => {
    await createVerified('caixa@exemplo.com')
    sent = []
    for (let i = 0; i < 8; i++) {
      await accounts.requestReset('caixa@exemplo.com')
      clock += 61_000
    }
    // 5 por hora contando todos os códigos da conta: o do cadastro, um minuto antes, já gastou um.
    expect(sent).toHaveLength(4)
  })

  it('código errado não calcula o hash da senha, e o relay nunca roda mais de 2 cálculos ao mesmo tempo', async () => {
    await accounts.signup('caro@exemplo.com')
    const code = lastCode('caro@exemplo.com')
    // Código errado responde na hora: o hash (centenas de ms) nem começa.
    const started = performance.now()
    await Promise.all(Array.from({ length: 4 }, () => accounts.verifySignup('caro@exemplo.com', wrong(code), PASSWORD)))
    expect(performance.now() - started).toBeLessThan(250)
    await Promise.all(Array.from({ length: 6 }, () => hashPassword('senha-qualquer-123')))
    expect(scryptPeak()).toBeLessThanOrEqual(2)
  }, 30_000)

  it('se gravar a senha falha, o código continua valendo: usar o mesmo código de novo funciona', async () => {
    await accounts.signup('falha@exemplo.com')
    const code = lastCode('falha@exemplo.com')
    await sql.unsafe(`create function kora_sync.falha() returns trigger language plpgsql as $$ begin raise exception 'banco fora'; end $$`)
    await sql.unsafe(`create trigger falha before update on kora_sync.accounts for each row execute function kora_sync.falha()`)
    try {
      await expect(accounts.verifySignup('falha@exemplo.com', code, PASSWORD)).rejects.toThrow('banco fora')
    } finally {
      await sql.unsafe(`drop trigger falha on kora_sync.accounts; drop function kora_sync.falha()`)
    }
    expect(await accounts.verifySignup('falha@exemplo.com', code, PASSWORD)).toMatchObject({ ok: true })
  })

  it('e-mail que não saiu não segura o próximo pedido: pedir de novo logo em seguida manda de verdade', async () => {
    let failing = true
    const flaky = new Accounts(sql, { send: async (to, email) => { if (failing) throw new Error('Resend fora'); sent.push({ to, email }) } }, { codeSecret: 'segredo-de-teste', logoUrl: 'https://exemplo/logo.png', now: () => clock })
    await expect(flaky.signup('instavel@exemplo.com')).rejects.toThrow('Resend fora')
    failing = false
    await flaky.signup('instavel@exemplo.com')
    expect(sent.map((item) => item.to)).toEqual(['instavel@exemplo.com'])
  })

  it('conta sem verificação ou bloqueada não entra, mas só diz isso para quem acertou a senha', async () => {
    await accounts.signup('e@exemplo.com')
    expect(await accounts.login('e@exemplo.com', PASSWORD)).toEqual({ ok: false, reason: 'invalid' })
    const id = await createVerified('f@exemplo.com')
    await sql`update kora_sync.accounts set blocked_at = now() where id = ${id}`
    expect(await accounts.login('f@exemplo.com', 'errada-errada')).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.login('f@exemplo.com', PASSWORD)).toEqual({ ok: false, reason: 'blocked' })
  })

  it('troca de senha: só quem recebe o código troca; a senha antiga deixa de valer', async () => {
    await createVerified('g@exemplo.com')
    sent = []
    await accounts.requestReset('ninguem@exemplo.com')
    expect(sent).toEqual([])
    await accounts.requestReset('g@exemplo.com')
    expect(sent.map((item) => item.email.subject)).toEqual(['Redefinição de senha do Kora'])
    expect(await accounts.confirmReset('g@exemplo.com', lastCode('g@exemplo.com'), 'nova-senha-boa')).toMatchObject({ ok: true })
    expect(await accounts.login('g@exemplo.com', PASSWORD)).toEqual({ ok: false, reason: 'invalid' })
    expect(await accounts.login('g@exemplo.com', 'nova-senha-boa')).toMatchObject({ ok: true })
  })

  it('senha curta é recusada e o banco guarda só o hash do código e da senha', async () => {
    await accounts.signup('h@exemplo.com')
    const code = lastCode('h@exemplo.com')
    expect(await accounts.verifySignup('h@exemplo.com', code, 'curta')).toEqual({ ok: false, reason: 'weak-password' })
    const [stored] = await sql<{ code_hash: string }[]>`select code_hash from kora_sync.codes`
    expect(stored!.code_hash).not.toContain(code)
    await accounts.verifySignup('h@exemplo.com', code, PASSWORD)
    const [account] = await sql<{ password_hash: string }[]>`select password_hash from kora_sync.accounts where email = 'h@exemplo.com'`
    expect(account!.password_hash).toMatch(/^scrypt\$/)
    expect(account!.password_hash).not.toContain(PASSWORD)
  })
})
