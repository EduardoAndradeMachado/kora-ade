import { resolveInside } from './files'
import { parseKoraFileUrl } from '../shared/file-url'

export class KoraFileError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string
  ) {
    super(message)
  }
}

// Separado do registro do protocolo para ser testável sem o runtime do Electron.
export function resolveKoraFileRequest(url: string, getProjectRoot: (id: string) => string): string {
  let ref
  try {
    ref = parseKoraFileUrl(url)
  } catch (err) {
    throw new KoraFileError(400, (err as Error).message)
  }
  let root: string
  try {
    root = getProjectRoot(ref.projectId)
  } catch (err) {
    throw new KoraFileError(404, (err as Error).message)
  }
  try {
    return resolveInside(root, ref.rel)
  } catch (err) {
    throw new KoraFileError(403, (err as Error).message)
  }
}
