import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { classHighlighter, highlightCode } from '@lezer/highlight'

type Parser = LanguageSupport['language']['parser']

// Bloco maior que isto fica sem cor: analisar um arquivo inteiro colado na resposta travaria a rolagem.
const MAX_CHARS = 50_000

// Um analisador por linguagem, baixado na primeira vez que ela aparece (o language-data carrega sob demanda).
const parsers = new Map<string, Promise<Parser | null>>()
function parserFor(name: string): Promise<Parser | null> {
  const key = name.toLowerCase()
  let parser = parsers.get(key)
  if (!parser) {
    const description = LanguageDescription.matchLanguageName(languages, key, true)
    parser = description ? description.load().then((support) => support.language.parser, () => null) : Promise.resolve(null)
    parsers.set(key, parser)
  }
  return parser
}

// O agente grava o código sem cor, com a linguagem na cerca (```ts): a cor é feita aqui, como o terminal faz.
export async function colorCodeBlocks(root: HTMLElement): Promise<void> {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    if (code.dataset['colored'] !== undefined) continue
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice('language-'.length)
    const text = code.textContent ?? ''
    if (!language || text.length > MAX_CHARS) continue
    const parser = await parserFor(language)
    if (!parser || !code.isConnected || code.dataset['colored'] !== undefined) continue
    const fragment = document.createDocumentFragment()
    highlightCode(text, parser.parse(text), classHighlighter, (piece, classes) => {
      if (!classes) return void fragment.append(piece)
      const span = document.createElement('span')
      span.className = classes
      span.textContent = piece
      fragment.append(span)
    }, () => fragment.append('\n'))
    code.replaceChildren(fragment)
    code.dataset['colored'] = ''
  }
}
