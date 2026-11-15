import type { MobileState } from '../../../shared/mobile'
import type { Project } from '../../../shared/state'

// "Configuração" acha "configuracao" e "CONFIGURAÇÃO": quem digita no celular raramente põe acento ou maiúscula.
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR')
}

// O projeto aparece na busca pelo nome, pela pasta, pelo nome de uma aba dele ou pelo nome da categoria em que está
// (e das categorias de cima). Busca vazia acha tudo.
export function projectMatcher(state: Pick<MobileState, 'projects' | 'groups' | 'tabs'>, search: string): (project: Project) => boolean {
  const query = fold(search.trim())
  if (!query) return () => true
  const byId = new Map(state.groups.map((group) => [group.id, group]))
  const categories = (project: Project): string[] => {
    const names: string[] = []
    const seen = new Set<string>()
    for (let id = project.hidden ? undefined : project.groupId; id && !seen.has(id); id = byId.get(id)?.parentId) {
      seen.add(id)
      const group = byId.get(id)
      if (group) names.push(group.name)
    }
    return names
  }
  return (project) => [project.name, project.path, ...categories(project), ...state.tabs.filter((tab) => tab.projectId === project.id).map((tab) => tab.title)]
    .some((text) => fold(text).includes(query))
}
