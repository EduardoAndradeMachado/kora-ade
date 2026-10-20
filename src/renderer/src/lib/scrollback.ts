type Snapshot = () => string

const snapshots = new Map<string, Snapshot>()

export function registerScrollback(id: string, snapshot: Snapshot): () => void {
  snapshots.set(id, snapshot)
  return () => {
    if (snapshots.get(id) === snapshot) snapshots.delete(id)
  }
}

// Serializa antes de qualquer await: o xterm é descartado logo depois de suspender ou sair do processo.
export async function saveScrollback(id: string): Promise<void> {
  const text = snapshots.get(id)?.()
  if (!text) return
  try {
    await window.kora.saveScrollback(id, text)
  } catch (err) {
    window.kora.reportError(`histórico do terminal ${id}: ${String(err)}`)
  }
}

export function saveScrollbackNow(id: string): void {
  void saveScrollback(id)
}

export async function saveAllScrollbacks(): Promise<void> {
  await Promise.all([...snapshots.keys()].map(saveScrollback))
}
