import DOMPurify from 'dompurify'
import { ALLOWED_URI, headingSlug, mobileRawUrl, resolveImage } from '@/lib/markdown-links'
import { markdownBlocks } from '@/lib/markdown-scroll'

// Mesmas regras do PC (markdown-links): imagem relativa ao .md ou à raiz (/), sem sair do projeto. A da pasta do
// arquivo usa o link de leitura dele; a de fora fica marcada (data-rel) e ganha um link próprio depois de desenhar.
// Os links ficam como estão no texto e são resolvidos no toque. Cada bloco de nível superior leva a linha (base 0)
// em que começa no texto (data-md-line): é por ela que o `arquivo.md:42` do terminal rola até o lugar certo.
export function markdownHtml(source: string, raw: string, docPath: string): string {
  const blocks = markdownBlocks(source).map((block) => `<div data-md-line="${block.line}">${block.html}</div>`).join('')
  const html = DOMPurify.sanitize(blocks, { ALLOWED_URI_REGEXP: ALLOWED_URI })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const seen = new Map<string, number>()
  for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.setAttribute('data-anchor', headingSlug(heading.textContent ?? '', seen))
  for (const img of doc.querySelectorAll('img')) {
    const image = resolveImage(img.getAttribute('src') ?? '', docPath)
    img.removeAttribute('srcset')
    img.removeAttribute('src')
    if (image?.kind === 'inline') img.setAttribute('src', image.url)
    else if (image?.kind === 'file') {
      const url = mobileRawUrl(raw, docPath, image.rel)
      if (url) img.setAttribute('src', url)
      else img.setAttribute('data-rel', image.rel)
    }
  }
  for (const code of doc.querySelectorAll('pre > code.language-mermaid')) code.parentElement?.setAttribute('data-mermaid', '')
  return doc.body.innerHTML
}

// O bloco onde a linha (base 1) cai: o último que começa nela ou antes.
export function blockAtLine(article: HTMLElement, line: number): HTMLElement | null {
  let found: HTMLElement | null = null
  for (const block of article.querySelectorAll<HTMLElement>(':scope > [data-md-line]')) {
    if (Number(block.dataset['mdLine']) <= line - 1) found = block
    else break
  }
  return found
}
