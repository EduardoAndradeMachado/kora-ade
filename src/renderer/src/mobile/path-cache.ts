export interface ResolvedPath { rel: string; line: number | null }
export type ResolvePath = (text: string) => Promise<ResolvedPath | null>

// A mesma resposta redesenhada não pergunta de novo ao PC. Só o arquivo achado fica guardado: o que ainda não existe
// (o agente cita antes de criar) vale por MISSING_MS, e a falha de rede não fica, senão o caminho nunca mais viraria
// toque até recarregar a página.
const MISSING_MS = 30_000
const cache = new Map<string, { value: Promise<ResolvedPath | null>; until: number }>()
export function cachedResolver(projectId: string, ask: ResolvePath, now = Date.now): ResolvePath {
  return (text) => {
    const key = `${projectId}\n${text}`
    const hit = cache.get(key)
    if (hit && hit.until > now()) return hit.value.catch(() => null)
    const value = ask(text)
    const entry = { value, until: Infinity }
    cache.set(key, entry)
    if (cache.size > 2000) cache.delete(cache.keys().next().value!)
    value.then(
      (found) => { if (!found) entry.until = now() + MISSING_MS },
      () => { if (cache.get(key) === entry) cache.delete(key) }
    )
    return value.catch(() => null)
  }
}
