import { findPathCandidates } from '@shared/terminal-links'
import type { ResolvePath } from './path-cache'

// Por mensagem: uma resposta que lista um diretório inteiro não vira dezenas de pedidos ao PC.
const MAX_PER_MESSAGE = 30

// Caminhos do texto das respostas viram toque, como no terminal: só o que existe no projeto (o PC confere), para
// número de versão e "5.5" não aparecerem sublinhados. Blocos de código e links ficam como estão.
export async function linkPaths(root: HTMLElement, resolve: ResolvePath): Promise<void> {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('pre, a, .path-link') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  let budget = MAX_PER_MESSAGE
  const work = nodes.flatMap((node) => {
    const text = node.data
    const candidates = findPathCandidates(text).slice(0, Math.max(0, budget))
    budget -= candidates.length
    return candidates.length ? [{ node, text, candidates }] : []
  })
  await Promise.all(work.map(async ({ node, text, candidates }) => {
    const found = await Promise.all(candidates.map((c) => resolve(c.text).catch(() => null)))
    if (!node.isConnected || node.data !== text) return
    // De trás para frente: cortar o fim do nó não muda a posição dos candidatos anteriores.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const target = found[i]
      if (!target) continue
      const { start, end } = candidates[i]!
      const tail = node.splitText(start)
      tail.splitText(end - start)
      const link = document.createElement('span')
      link.className = 'path-link'
      link.dataset['rel'] = target.rel
      if (target.line !== null) link.dataset['line'] = String(target.line)
      tail.replaceWith(link)
      link.append(tail)
    }
  }))
}
