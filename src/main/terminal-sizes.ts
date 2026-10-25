import { DESKTOP } from '../shared/mobile'

export interface TerminalSize {
  cols: number
  rows: number
}

export interface SizeChange extends TerminalSize {
  holder: string
}

export { DESKTOP }

// O pty tem um tamanho só, mas a aba aparece no PC e em cada celular conectado. Cada tela registra o tamanho
// que quer e vale o de quem interagiu por último; quando essa tela sai, o tamanho volta para o PC.
export class TerminalSizes {
  private readonly wanted = new Map<string, Map<string, TerminalSize>>()
  private readonly holders = new Map<string, string>()

  holder(id: string): string | null {
    return this.holders.get(id) ?? null
  }

  viewers(id: string): string[] {
    return [...(this.wanted.get(id)?.keys() ?? [])]
  }

  current(id: string): SizeChange | null {
    const holder = this.holders.get(id)
    const size = holder === undefined ? undefined : this.wanted.get(id)?.get(holder)
    return holder !== undefined && size ? { ...size, holder } : null
  }

  want(id: string, client: string, size: TerminalSize): SizeChange | null {
    let sizes = this.wanted.get(id)
    if (!sizes) this.wanted.set(id, (sizes = new Map()))
    sizes.set(client, { cols: size.cols, rows: size.rows })
    const holder = this.holders.get(id)
    if (holder === undefined) this.holders.set(id, client)
    else if (holder !== client) return null
    return { cols: size.cols, rows: size.rows, holder: client }
  }

  take(id: string, client: string): SizeChange | null {
    const size = this.wanted.get(id)?.get(client)
    if (!size || this.holders.get(id) === client) return null
    this.holders.set(id, client)
    return { ...size, holder: client }
  }

  leave(id: string, client: string): SizeChange | null {
    const sizes = this.wanted.get(id)
    if (!sizes?.delete(client) || this.holders.get(id) !== client) return null
    const next = sizes.has(DESKTOP) ? DESKTOP : sizes.keys().next().value
    if (next === undefined) {
      this.holders.delete(id)
      return null
    }
    this.holders.set(id, next)
    return { ...sizes.get(next)!, holder: next }
  }

  leaveAll(client: string): [string, SizeChange][] {
    const changes: [string, SizeChange][] = []
    for (const id of this.wanted.keys()) {
      const change = this.leave(id, client)
      if (change) changes.push([id, change])
    }
    return changes
  }

  forget(id: string): void {
    this.wanted.delete(id)
    this.holders.delete(id)
  }
}
