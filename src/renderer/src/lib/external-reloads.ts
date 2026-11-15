import type { editor } from 'monaco-editor'

// A mudança que um agente faz no disco entra no editor limpo como uma edição desfazível: o Ctrl+Z pode voltar ao
// texto de antes dela de propósito. O perigo é salvar sem perceber e apagar o trabalho do agente. Aqui se descobre
// se o texto do editor vem de antes da última recarga externa.
//
// O Monaco dá a cada estado do texto um número (getAlternativeVersionId): edição nova ganha um número maior que
// todos os anteriores, e desfazer/refazer volta ao número exato do estado de antes. `parents` liga cada estado
// criado por edição ao estado de onde ela partiu. O editor está "antes da recarga" quando o estado atual não
// descende dela: desfez até antes, ou desfez e digitou por cima do texto antigo.
export function isBeforeReload(parents: ReadonlyMap<number, number>, reload: number | null, current: number): boolean {
  if (reload === null) return false
  let state: number | undefined = current
  // O pai sempre tem número menor: a subida para assim que passa da recarga.
  while (state !== undefined && state > reload) state = parents.get(state)
  return state !== reload
}

export interface ExternalReloads {
  // Troca o texto todo pelo do disco como uma única edição desfazível e marca esse ponto.
  apply(content: string): void
  isBeforeReload(): boolean
  // Gravou: se foi por cima da mudança de fora, a pessoa confirmou, e o aviso não volta para essa recarga.
  saved(): void
  dispose(): void
}

export function trackExternalReloads(model: editor.ITextModel): ExternalReloads {
  const parents = new Map<number, number>()
  let reload: number | null = null
  let last = model.getAlternativeVersionId()

  const forget = (): void => {
    parents.clear()
    reload = null
  }

  const subscription = model.onDidChangeContent((e) => {
    const current = model.getAlternativeVersionId()
    // setValue (Recarregar do disco, reabrir com codificação) zera o desfazer: não há mais para onde voltar.
    if (e.isFlush) forget()
    else if (reload !== null && !e.isUndoing && !e.isRedoing) parents.set(current, last)
    last = current
  })

  return {
    apply(content) {
      const before = model.getAlternativeVersionId()
      model.pushStackElement()
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
      model.pushStackElement()
      const after = model.getAlternativeVersionId()
      if (after === before) return
      // Só os estados depois da recarga importam para a subida.
      for (const state of parents.keys()) if (state <= after) parents.delete(state)
      reload = after
    },
    isBeforeReload: () => isBeforeReload(parents, reload, model.getAlternativeVersionId()),
    saved() {
      if (isBeforeReload(parents, reload, model.getAlternativeVersionId())) forget()
    },
    dispose: () => subscription.dispose()
  }
}
