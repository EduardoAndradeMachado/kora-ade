// As definições Monarch do Monaco são publicadas sem tipos.
declare module 'monaco-editor/languages/definitions/*' {
  import type { languages } from 'monaco-editor'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}
