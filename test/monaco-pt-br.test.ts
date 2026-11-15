import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MONACO_PT_BR } from '../src/renderer/src/lib/monaco-pt-br'

const MONACO_ESM = join(__dirname, '..', 'node_modules', 'monaco-editor', 'esm', 'vs')

interface Call {
  index: number
  text: string
  // Descrição de ícone e de cor só aparece em tela de configuração do VS Code, que o Monaco não tem.
  metadata: boolean
}

// Literal de string do JavaScript para o texto, pelo JSON: \' e \xNN não existem nele.
const stringValue = (literal: string): string => {
  const inner = literal.slice(1, -1).replace(/\\'/g, "'")
  const body = literal.startsWith('"') ? inner : inner.replace(/"/g, '\\"')
  return JSON.parse(`"${body.replace(/\\x([0-9a-f]{2})/gi, '\\u00$1')}"`) as string
}

// As chamadas localize(n, "texto") do build ESM, que é o que o Vite empacota.
// Com `only`, só lê os textos desses números: o pacote tem literais que o JSON não aceita, e eles não interessam.
function localizeCalls(file: string, only?: Set<number>): Call[] {
  const call = /\blocalize2?\((\d+),\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g
  const calls: Call[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    for (const match of line.matchAll(call)) {
      if (only && !only.has(Number(match[1]))) continue
      const text = stringValue(match[2] ?? '')
      calls.push({ index: Number(match[1]), text, metadata: /register(Icon|Color)\(/.test(line.slice(0, match.index)) })
    }
  }
  return calls
}

// O inglês que cada número tem no Monaco instalado.
function installedMessages(): Map<number, string> {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (path.endsWith('.js')) files.push(path)
    }
  }
  walk(MONACO_ESM)
  const wanted = new Set(MONACO_PT_BR.map(([index]) => index))
  const messages = new Map<number, string>()
  for (const file of files) for (const { index, text } of localizeCalls(file, wanted)) messages.set(index, text)
  return messages
}

// O que aparece no Ctrl+G, no Ctrl+F/Ctrl+H e na paleta do F1. Atualização do Monaco que traga texto novo nesses
// lugares fica vermelha aqui em vez de aparecer em inglês na tela.
const SCREENS = [
  'editor/contrib/quickAccess/browser/gotoLineQuickAccess.js',
  'editor/contrib/find/browser/findWidget.js',
  'editor/contrib/find/browser/findController.js',
  'base/browser/ui/findinput/findInput.js',
  'base/browser/ui/findinput/findInputToggles.js',
  'base/browser/ui/findinput/replaceInput.js',
  'platform/quickinput/browser/commandsQuickAccess.js'
]

describe('Monaco em português', () => {
  it('cada número traduzido ainda é o mesmo texto em inglês no Monaco instalado', () => {
    const installed = installedMessages()
    const wrong = MONACO_PT_BR.filter(([index, english]) => installed.get(index) !== english).map(
      ([index, english]) => `${index}: esperado "${english}", no Monaco "${installed.get(index)}"`
    )
    expect(wrong).toEqual([])
  })

  it('Ir para linha, localizar/substituir e a paleta de comandos não deixam texto em inglês', () => {
    const translated = new Set(MONACO_PT_BR.map(([index]) => index))
    const missing = SCREENS.flatMap((file) =>
      localizeCalls(join(MONACO_ESM, file))
        // "{0}, {1}" e afins não têm palavra para traduzir.
        .filter((c) => !c.metadata && /[a-z]/i.test(c.text.replace(/\{\d+\}/g, '')) && !translated.has(c.index))
        .map((c) => `${file}: ${c.index} "${c.text}"`)
    )
    expect(missing).toEqual([])
  })

  it('a tabela vai para o global que o Monaco lê', () => {
    const messages = (globalThis as { _VSCODE_NLS_MESSAGES?: (string | null)[] })._VSCODE_NLS_MESSAGES
    expect(messages?.[1108]).toBe('Ir para definição')
    expect(messages?.[1390]).toBe('Digite o número da linha para onde ir (de 1 a {0}).')
  })
})
