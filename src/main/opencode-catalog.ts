import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { queryOpencode } from './opencode'

// Catálogo de modelos (models.dev) que o próprio OpenCode mantém. A v2.3 guarda no banco (kv); versões
// anteriores guardavam em ~/.cache/opencode/models.json com o mesmo recorte provedor → modelos.
type Json = Record<string, unknown>
export type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

export interface CatalogModel {
  limit?: { context?: number }
  cost?: Json
}

const CATALOG_KEY = 'models-dev:v2:catalog'
let cached: { source: string; stamp: number; data: Catalog } | null = null

function fromDb(dbFile: string): Catalog | null {
  const stamp = queryOpencode<{ time_updated: number }>(dbFile, 'kv', 'select time_updated from kv where key = ?', [CATALOG_KEY])?.[0]
  if (!stamp) return null
  // O valor tem uns 13 MB e vem antes do time_updated na linha: até ler o carimbo custa ~16 ms.
  // Quem chama carrega o catálogo uma vez por leitura de métricas, não por mensagem.
  if (cached?.source === dbFile && cached.stamp === stamp.time_updated) return cached.data
  const row = queryOpencode<{ value: string }>(dbFile, 'kv', 'select value from kv where key = ?', [CATALOG_KEY])?.[0]
  try {
    const body = (JSON.parse(row!.value) as { body?: unknown }).body
    const data = JSON.parse(typeof body === 'string' ? body : '') as Catalog
    cached = { source: dbFile, stamp: stamp.time_updated, data }
    return data
  } catch {
    return null
  }
}

function fromCacheFile(env: NodeJS.ProcessEnv): Catalog | null {
  const cacheRoot = env['XDG_CACHE_HOME']?.trim() || join(homedir(), '.cache')
  const file = join(cacheRoot, 'opencode', 'models.json')
  try {
    const { mtimeMs } = statSync(file)
    if (cached?.source !== file || cached.stamp !== mtimeMs) cached = { source: file, stamp: mtimeMs, data: JSON.parse(readFileSync(file, 'utf8')) as Catalog }
    return cached.data
  } catch {
    return null
  }
}

export type ModelLookup = (provider: string, model: string) => CatalogModel | null

export function opencodeCatalog(dbFile: string, env: NodeJS.ProcessEnv = process.env): ModelLookup {
  const catalog = fromDb(dbFile) ?? fromCacheFile(env)
  return (provider, model) => catalog?.[provider]?.models?.[model] ?? null
}

export interface CatalogUsage {
  // Como o OpenCode grava: entrada sem o cache; raciocínio à parte da saída.
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const price = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function compare(rule: unknown, value: string | number | boolean | null): boolean {
  if (!isObj(rule) || value === null) return false
  for (const [op, expected] of Object.entries(rule)) {
    // "06:00" < "10:00" e "2026-12-01" >= "2026-11-30" valem como texto: o formato tem largura fixa.
    const ordered = typeof value !== 'boolean' && typeof expected === typeof value
    const a = value as string | number
    const b = expected as string | number
    const ok =
      op === 'equals' ? value === expected
      : op === 'in' ? Array.isArray(expected) && expected.includes(value)
      : op === 'gt' ? ordered && a > b
      : op === 'gte' ? ordered && a >= b
      : op === 'lt' ? ordered && a < b
      : op === 'lte' ? ordered && a <= b
      : false
    if (!ok) return false
  }
  return true
}

const pad = (n: number): string => String(n).padStart(2, '0')

// Condições que o Kora não sabe da chamada (região, tier flex, imagem, feriado) contam como falsas: são desvios
// opcionais do preço padrão. Um "not feriado" então sempre vale, e o horário de pico conta também em feriado.
function matches(when: unknown, ctx: { context: number; at: number }): boolean {
  if (!isObj(when)) return false
  const d = new Date(ctx.at)
  for (const [key, rule] of Object.entries(when)) {
    const ok =
      key === 'all' ? Array.isArray(rule) && rule.every((w) => matches(w, ctx))
      : key === 'any' ? Array.isArray(rule) && rule.some((w) => matches(w, ctx))
      : key === 'not' ? !matches(rule, ctx)
      : key === 'context' ? compare(rule, ctx.context)
      : key === 'date' ? compare(rule, `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`)
      : key === 'utc_days' ? compare(rule, DAYS[d.getUTCDay()]!)
      : key === 'utc_hours' ? compare(rule, `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`)
      : false
    if (!ok) return false
  }
  return true
}

function withOverride(part: Json, ctx: { context: number; at: number }): Json {
  const overrides = Array.isArray(part['overrides']) ? part['overrides'] : []
  const hit = overrides.find((o) => isObj(o) && matches(o['when'], ctx)) as Json | undefined
  return hit ? { ...part, ...hit } : part
}

// Gravação de cache com várias durações (5m/1h, 30m/12h): o OpenCode não diz qual usou; vale a mais curta, a padrão.
function writePrice(cache: unknown): number | null {
  if (!isObj(cache)) return null
  const w = cache['write']
  if (isObj(w)) return price(Object.values(w)[0])
  return price(w)
}

/** US$ da resposta pela tabela do catálogo, no dia e hora `at`; null se o modelo não tem preço de texto legível. */
export function catalogCost(model: CatalogModel, u: CatalogUsage, at: number): number | null {
  const text = isObj(model.cost) && isObj(model.cost['text']) ? model.cost['text'] : null
  if (!text || !isObj(text['input']) || !isObj(text['output'])) return null
  const ctx = { context: u.input + u.cacheRead + u.cacheWrite, at }
  const input = withOverride(text['input'], ctx)
  const output = withOverride(text['output'], ctx)
  const inPrice = price(input['price'])
  const outPrice = price(output['price'])
  if (inPrice === null || outPrice === null) return null
  const cache = isObj(input['cache']) ? input['cache'] : {}
  const readPrice = price(cache['read']) ?? inPrice
  const cacheWrite = writePrice(cache) ?? inPrice
  const reasoningPrice = price(output['reasoning']) ?? outPrice
  const multipliers = Array.isArray(model.cost!['multipliers']) ? model.cost!['multipliers'] : []
  // O fator vem como número ou por modalidade ({ text: 1.8, audio: 1.8 }); aqui só entra texto.
  const textFactor = (v: unknown): number => price(isObj(v) ? v['text'] : v) ?? 1
  const factor = multipliers.reduce<number>((f, m) => (isObj(m) && matches(m['when'], ctx) ? f * textFactor(m['factor']) : f), 1)
  const usd = u.input * inPrice + u.cacheRead * readPrice + u.cacheWrite * cacheWrite + u.output * outPrice + u.reasoning * reasoningPrice
  return (usd * factor) / 1_000_000
}

export const catalogContext = (model: CatalogModel | null): number | null => {
  const context = model?.limit?.context
  return typeof context === 'number' && context > 0 ? context : null
}
