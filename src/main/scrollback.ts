import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Um arquivo por aba, sobrescrito a cada suspensão: o uso normal não faz a pasta crescer.
export const SCROLLBACK_MAX_BYTES = 2_000_000

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const FILE = /^([A-Za-z0-9][A-Za-z0-9-]{0,63})\.txt$/

function cap(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= SCROLLBACK_MAX_BYTES) return text
  // Um agente que imprime muito não pode encher o disco: fica a parte mais nova, a partir de uma linha inteira.
  const tail = Buffer.from(text, 'utf8').subarray(-SCROLLBACK_MAX_BYTES)
  const newline = tail.indexOf(0x0a)
  return tail.subarray(newline >= 0 && newline < 4096 ? newline + 1 : 0).toString('utf8')
}

export class Scrollbacks {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new Error(`ID de aba inválido: ${JSON.stringify(id)}`)
    return join(this.dir, `${id}.txt`)
  }

  save(id: string, text: string): void {
    if (text.length === 0) return
    mkdirSync(this.dir, { recursive: true })
    const file = this.file(id)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, cap(text), 'utf8')
    renameSync(tmp, file)
  }

  load(id: string): string | null {
    try {
      return readFileSync(this.file(id), 'utf8')
    } catch {
      return null
    }
  }

  // Fecha o ciclo: só fica o histórico de aba que ainda existe. Vale para aba fechada, projeto removido,
  // arquivo de versão anterior e sobra de gravação interrompida.
  prune(keep: Iterable<string>): void {
    const alive = new Set(keep)
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const id = FILE.exec(name)?.[1]
      if (id && !alive.has(id)) {
        try {
          rmSync(join(this.dir, name), { force: true })
        } catch {
          // Arquivo em uso por outro processo: a próxima abertura tenta de novo.
        }
      } else if (name.endsWith('.txt.tmp')) {
        try {
          rmSync(join(this.dir, name), { force: true })
        } catch {
          // Idem.
        }
      }
    }
  }
}
