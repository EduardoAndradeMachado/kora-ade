import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const BLOCKED = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RETRIES = 5
const RETRY_WAIT_MS = 30

export const isBlocked = (err: unknown): boolean => BLOCKED.has((err as NodeJS.ErrnoException).code ?? '')

// Antivírus e indexador seguram arquivos por instantes no Windows. O caminho é síncrono e raro: a espera ocupada
// segura a thread principal por até meio segundo a cada arquivo preso.
function retrying<T>(action: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return action()
    } catch (err) {
      if (attempt >= RETRIES || !isBlocked(err)) throw err
      const until = performance.now() + RETRY_WAIT_MS * (attempt + 1)
      while (performance.now() < until);
    }
  }
}

export const readTextRetrying = (file: string): string => retrying(() => readFileSync(file, 'utf8'))

export const renameRetrying = (from: string, to: string): void => retrying(() => renameSync(from, to))

// Sem fsync, uma queda de energia logo depois do rename deixa o nome novo apontando para setores que nunca
// foram gravados: o arquivo volta com o tamanho certo e cheio de zeros.
export function writeDurable(file: string, text: string): void {
  const fd = openSync(file, 'w')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function replaceDurable(file: string, text: string): void {
  const tmp = `${file}.tmp`
  try {
    writeDurable(tmp, text)
    renameRetrying(tmp, file)
  } catch (err) {
    // O pareamento do celular guarda chave privada: não fica esquecida num .tmp.
    rmSync(tmp, { force: true })
    throw err
  }
}
