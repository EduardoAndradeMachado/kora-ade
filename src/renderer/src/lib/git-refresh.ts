// Ação do Kora que mexe no repositório (commit, fila, trecho, desfazer): avisa na hora quem mostra o estado
// do git (painel, abas de diff), sem esperar o watcher, que pode juntar ou perder a mudança dentro do .git.
const EVENT = 'kora:git-changed'

export function notifyGitChanged(projectId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: projectId }))
}

export function onGitChanged(projectId: string, listener: () => void): () => void {
  const handler = (e: Event): void => {
    if ((e as CustomEvent<string>).detail === projectId) listener()
  }
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
