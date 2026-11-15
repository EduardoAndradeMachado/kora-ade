import { monaco } from '@/lib/monaco'
import { editorLanguageFor, isWorkerLanguage, LIGHT_LANGUAGE_SUFFIX } from '@shared/open-limits'
import { setWorkerRestarter } from '@/lib/memory-budget'

// Variantes "leves" das linguagens com worker: o mesmo realce Monarch do Monaco, sem worker de análise. Um model
// com a linguagem original é copiado inteiro para o worker na criação, então a troca tem de valer já no createModel.

type Monarch = { conf: monaco.languages.LanguageConfiguration; language: monaco.languages.IMonarchLanguage }

const MONARCH: Record<string, () => Promise<Monarch>> = {
  typescript: () => import('monaco-editor/languages/definitions/typescript/typescript'),
  javascript: () => import('monaco-editor/languages/definitions/javascript/javascript'),
  // O Monaco não tem Monarch de JSON (o realce vem do pacote do worker); o de JavaScript pinta strings, números,
  // true/false/null e chaves do mesmo jeito.
  json: () => import('monaco-editor/languages/definitions/javascript/javascript'),
  css: () => import('monaco-editor/languages/definitions/css/css'),
  scss: () => import('monaco-editor/languages/definitions/scss/scss'),
  less: () => import('monaco-editor/languages/definitions/less/less'),
  html: () => import('monaco-editor/languages/definitions/html/html'),
  handlebars: () => import('monaco-editor/languages/definitions/handlebars/handlebars'),
  razor: () => import('monaco-editor/languages/definitions/razor/razor')
}

for (const [base, load] of Object.entries(MONARCH)) {
  const id = base + LIGHT_LANGUAGE_SUFFIX
  const label = monaco.languages.getLanguages().find((l) => l.id === base)?.aliases?.[0] ?? base
  monaco.languages.register({ id, aliases: [`${label} (arquivo grande, sem análise)`] })
  monaco.languages.onLanguage(id, () => {
    void load().then(({ conf, language }) => {
      monaco.languages.setLanguageConfiguration(id, conf)
      monaco.languages.setMonarchTokensProvider(id, language)
    })
  })
}

// A linguagem que o Monaco deduziria pelo nome, só para as que têm worker (as outras não mudam).
function workerLanguageByName(path: string): string | undefined {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  for (const lang of monaco.languages.getLanguages()) {
    if (!isWorkerLanguage(lang.id)) continue
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
    if (lang.extensions?.some((ext) => name.endsWith(ext.toLowerCase()))) return lang.id
  }
  return undefined
}

// `explicit`: a linguagem que o Kora já escolheu pelo nome (languageForPath). undefined deixa o Monaco deduzir.
export function editorLanguage(path: string, length: number, explicit: string | undefined): string | undefined {
  const detected = explicit ?? workerLanguageByName(path)
  const chosen = editorLanguageFor(detected, length)
  return chosen === detected ? explicit : chosen
}

// Mudar as opções de um "defaults" faz o Monaco descartar o worker daquela linguagem; o próximo uso cria outro, que
// recebe só os models abertos. Mesmas opções: nada muda além disso.
setWorkerRestarter(() => {
  for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) d.setDiagnosticsOptions(d.getDiagnosticsOptions())
  monaco.json.jsonDefaults.setDiagnosticsOptions(monaco.json.jsonDefaults.diagnosticsOptions)
})
