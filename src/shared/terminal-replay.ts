// Tela que abre com um processo já rodando (aba aberta pelo celular, interface recarregada depois de uma queda):
// a saída que chega antes da foto da tela espera na fila. A foto já traz tudo até a sequência dela; o que estava
// na fila até ali repetiria linhas, e o que veio depois ainda não está nela.
export class SnapshotGate {
  private queued: { data: string; sequence?: number }[] | null = []
  private shown = -Infinity

  constructor(private readonly write: (data: string) => void) {}

  push(data: string, sequence?: number): void {
    if (this.queued) {
      this.queued.push({ data, sequence })
      return
    }
    // A resposta do pedido da foto e os pedaços da saída vêm por mensagens do IPC sem ordem garantida entre si
    // (visto no Electron): um pedaço que a foto já traz pode chegar depois dela.
    if (sequence !== undefined && sequence <= this.shown) return
    this.write(data)
  }

  release(snapshot: { data: string; sequence: number } | null): void {
    const queued = this.queued
    if (!queued) return
    this.queued = null
    if (snapshot) {
      this.shown = snapshot.sequence
      this.write(snapshot.data)
    }
    for (const chunk of queued) this.push(chunk.data, chunk.sequence)
  }
}
