import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

// O Monaco resolve sozinho os workers com `new URL(..., import.meta.url)`, o que quebra no
// pré-bundle do Vite em dev; com `getWorker` definido esse caminho nunca é usado.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

// Sem o projeto inteiro carregado no worker, todo import vira "Cannot find module"; a
// validação semântica só geraria sublinhado vermelho falso. A de sintaxe continua.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
}

const DARK_THEME = 'kora-dark'
const LIGHT_THEME = 'kora-light'

monaco.editor.defineTheme(DARK_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1f2126',
    'editor.foreground': '#d3d6de',
    'editorGutter.background': '#1f2126',
    'editor.lineHighlightBackground': '#ffffff08',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#7d95e84d',
    'editor.inactiveSelectionBackground': '#7d95e826',
    'editorCursor.foreground': '#d3d6de',
    'editorLineNumber.foreground': '#5b606b',
    'editorLineNumber.activeForeground': '#8d929d',
    'editorIndentGuide.background1': '#ffffff0d',
    'editorIndentGuide.activeBackground1': '#ffffff24',
    'editorWidget.background': '#1e2025',
    'editorWidget.border': '#ffffff1f',
    'editorSuggestWidget.background': '#1e2025',
    'editorSuggestWidget.border': '#ffffff1f',
    'editorSuggestWidget.selectedBackground': '#323640',
    'input.background': '#16171b',
    'input.border': '#ffffff1f',
    'focusBorder': '#7d95e8',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff24',
    'scrollbarSlider.activeBackground': '#ffffff33',
    'minimap.background': '#1f2126'
  }
})

monaco.editor.defineTheme(LIGHT_THEME, {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#15171b',
    'editorGutter.background': '#ffffff',
    'editor.lineHighlightBackground': '#0000000a',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#6f86d640',
    'editor.inactiveSelectionBackground': '#6f86d620',
    'editorLineNumber.foreground': '#a3a7b0',
    'editorLineNumber.activeForeground': '#666b76',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#dfe2e8',
    'input.background': '#f6f7f9',
    'input.border': '#d6d9e0',
    'focusBorder': '#6f86d6',
    'scrollbarSlider.background': '#0000001a',
    'scrollbarSlider.hoverBackground': '#0000002e',
    'minimap.background': '#ffffff'
  }
})

export const themeForDocument = (): string => (document.documentElement.classList.contains('dark') ? DARK_THEME : LIGHT_THEME)

// O tema do Monaco é global: acompanha a classe .dark do documento, que muda quando o usuário troca o tema.
new MutationObserver(() => monaco.editor.setTheme(themeForDocument())).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class']
})

// Sem `theme` aqui: o valor seria o do carregamento do módulo e, passado ao create, voltaria o tema global.
export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  fontSize: 13,
  fontLigatures: false,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  smoothScrolling: true,
  padding: { top: 8 }
}

export { monaco }
