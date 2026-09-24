type Handler = (data: string) => void

// O shell começa a escrever (prompt, banner) antes do xterm da aba montar e se inscrever;
// sem guardar esses chunks a aba abre em branco.
export class TerminalBus {
  private readonly handlers = new Map<string, Handler>()
  private readonly pending = new Map<string, string[]>()
  // Saída que chega depois de fechar/suspender a aba (o processo morrendo) não tem mais leitor;
  // guardá-la seria acumular memória para sempre.
  private readonly closed = new Set<string>()

  push(id: string, data: string): void {
    const handler = this.handlers.get(id)
    if (handler) {
      handler(data)
      return
    }
    if (this.closed.has(id)) return
    const queue = this.pending.get(id)
    if (queue) queue.push(data)
    else this.pending.set(id, [data])
  }

  // Chamado antes de (re)abrir o processo da aba: a partir daqui a saída volta a ser guardada até a inscrição.
  expect(id: string): void {
    this.closed.delete(id)
  }

  subscribe(id: string, handler: Handler): () => void {
    this.closed.delete(id)
    this.handlers.set(id, handler)
    const queued = this.pending.get(id)
    if (queued) {
      this.pending.delete(id)
      for (const chunk of queued) handler(chunk)
    }
    return () => {
      if (this.handlers.get(id) === handler) this.handlers.delete(id)
    }
  }

  forget(id: string): void {
    this.handlers.delete(id)
    this.pending.delete(id)
    this.closed.add(id)
  }

  pendingCount(): number {
    return this.pending.size
  }
}
