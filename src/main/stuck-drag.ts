// Só o que o destravamento usa do depurador do webContents, para o teste trocar por um falso.
export interface DragTarget {
  isDestroyed(): boolean
  debugger: {
    isAttached(): boolean
    attach(protocolVersion?: string): void
    detach(): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
}

// O comando responde em milissegundos; sem resposta nesse prazo a página caiu ou foi recriada no meio.
export const RELEASE_TIMEOUT_MS = 2000

const inFlight = new WeakMap<DragTarget, Promise<void>>()

// O Chromium ignora mouse e teclado enquanto a página acha que há um arrasto em andamento. Com a máquina engasgada o
// aviso de fim do arrasto se perde, e a interface segue desenhando sem aceitar mais nada. O protocolo de depuração é o
// único caminho que o Electron oferece para mandar esse fim à página; sem arrasto preso o comando não muda nada.
export function releaseStuckDrag(contents: DragTarget): Promise<void> {
  const running = inFlight.get(contents)
  if (running) return running
  const release = cancelDrag(contents).finally(() => inFlight.delete(contents))
  inFlight.set(contents, release)
  return release
}

async function cancelDrag(contents: DragTarget): Promise<void> {
  if (contents.isDestroyed()) return
  const session = contents.debugger
  const attachedHere = !session.isAttached()
  if (attachedHere) session.attach('1.3')
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      session.sendCommand('Input.dispatchDragEvent', {
        type: 'dragCancel',
        x: 0,
        y: 0,
        data: { items: [], dragOperationsMask: 1 }
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('a interface não respondeu ao cancelamento do arrasto')), RELEASE_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
    if (attachedHere && !contents.isDestroyed() && session.isAttached()) session.detach()
  }
}
