import { touchesFile } from '../../../shared/file-change'
import type { MobileFilesEvent, MobileFileStat } from '../../../shared/mobile'

// O que fazer quando o arquivo aberto mudou no PC (o agente gravou, apagou ou renomeou):
// - reload: sem nada por salvar no celular, traz a versão nova sozinho;
// - conflict: há rascunho, avisa na hora (e não só quando ele tentar salvar);
// - gone: sumiu do PC; o que está na tela (e o rascunho) fica;
// - same: é a versão que o celular já tem (inclusive a que ele mesmo acabou de salvar).
export type FollowAction = 'same' | 'reload' | 'conflict' | 'gone'

// known: a versão (mtime) que o celular mostra ou sobre a qual o rascunho foi feito; null quando ele já sabe que
// o arquivo sumiu, e aí qualquer arquivo que volte com o mesmo nome é versão nova.
export function followAction(known: number | null, stat: MobileFileStat, hasDraft: boolean): FollowAction {
  if (!stat.exists) return known === null ? 'same' : 'gone'
  if (known !== null && stat.mtimeMs === known) return 'same'
  return hasDraft ? 'conflict' : 'reload'
}

// O aviso do observador de pastas do PC fala deste arquivo? PC antigo (sem a lista de arquivos no aviso) conta
// como "talvez", e o celular confere o stat.
export function eventTouches(event: MobileFilesEvent, projectId: string, path: string): boolean {
  if (event.projectId !== projectId) return false
  const files = event.files
  return touchesFile({ dirs: event.dirs, files: files ?? [], allFiles: files === undefined || event.allFiles === true, git: event.git, ignoreRules: false, rescan: event.rescan }, path)
}
