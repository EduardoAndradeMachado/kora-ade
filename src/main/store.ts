import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { emptyState, parseState, StateSchema, type KoraState } from '../shared/state'

export function loadState(file: string): KoraState {
  if (!existsSync(file)) return emptyState()
  try {
    return parseState(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    // Arquivo ilegível não pode ser sobrescrito pelo próximo save: é a lista de projetos do usuário.
    const backup = `${file}.corrupt-${Date.now()}`
    renameSync(file, backup)
    console.error(`[kora] estado inválido em ${file}; preservado em ${backup}`, err)
    return emptyState()
  }
}

export function saveState(file: string, state: KoraState): void {
  const valid = StateSchema.parse(state)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(valid, null, 2), 'utf8')
  renameSync(tmp, file)
}
