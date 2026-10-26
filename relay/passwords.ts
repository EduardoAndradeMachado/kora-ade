import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

// scrypt com os parâmetros da OWASP (N=2^17, r=8, p=1): ~128 MiB e algumas centenas de ms por tentativa, caro para
// quem testa senhas vazadas em massa. Os parâmetros vão junto no hash, então dá para endurecer depois sem quebrar
// as senhas antigas.
const N = 2 ** 17
const R = 8
const P = 1
const KEY_BYTES = 32

export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 128

// No máximo 2 cálculos ao mesmo tempo, no relay inteiro: cada um ocupa ~128 MiB e um dos 4 threads do Node, e uma
// enxurrada de logins ou códigos travaria o resto (inclusive a conexão com o banco). Os outros esperam na fila.
const SLOTS = 2
let running = 0
let peak = 0
const queue: (() => void)[] = []

// Maior número de cálculos simultâneos já visto (para o teste conferir o teto).
export const scryptPeak = (): number => peak

async function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  if (running >= SLOTS) await new Promise<void>((resolve) => queue.push(resolve))
  running++
  peak = Math.max(peak, running)
  try {
    return await new Promise((resolve, reject) =>
      scryptCallback(password.normalize('NFKC'), salt, KEY_BYTES, { N: n, r, p, maxmem: 256 * n * r }, (error, key) => (error ? reject(error) : resolve(key)))
    )
  } finally {
    running--
    queue.shift()?.()
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, N, R, P)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Hash de uma senha que não existe: o login de e-mail desconhecido gasta o mesmo tempo que o de senha errada, e
// ninguém descobre pelo relógio quais e-mails têm conta.
let decoy: Promise<string> | null = null
export const decoyHash = (): Promise<string> => (decoy ??= hashPassword(randomBytes(16).toString('hex')))
