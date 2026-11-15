import * as monaco from 'monaco-editor'
import { parseConflicts, resolutionEdit, resolveAll, type ConflictBlock, type ConflictChoice } from '@/lib/git-conflicts'

// CodeLens e cores dos blocos de conflito em qualquer editor de arquivo, como a extensão de merge do VS Code.
// Registrado uma vez, no carregamento do Monaco: provider de CodeLens e decorações são globais por model.

const ACCEPT = 'kora.conflito.aceitar'
const COMPARE = 'kora.conflito.comparar'
const DEBOUNCE_MS = 150

// Só o arquivo aberto para edição (URI file:). O lado original de um diff também é um model e não é editável.
const editable = (model: monaco.editor.ITextModel): boolean => model.uri.scheme === 'file'

// Antes de montar a lista de linhas do arquivo inteiro: arquivo grande sem conflito não paga nada a cada tecla.
function blocksOf(model: monaco.editor.ITextModel): ConflictBlock[] {
  if (!model.findNextMatch('<<<<<<<', { lineNumber: 1, column: 1 }, false, true, null, false)) return []
  return parseConflicts(model.getLinesContent())
}

// Cores da extensão de merge do VS Code: atual em verde-água, entrada em azul, base em cinza.
const STYLE = `
.kora-conflito-atual-cab { background: rgba(64, 200, 174, 0.5); }
.kora-conflito-atual { background: rgba(64, 200, 174, 0.2); }
.kora-conflito-entrada-cab { background: rgba(64, 166, 255, 0.5); }
.kora-conflito-entrada { background: rgba(64, 166, 255, 0.2); }
.kora-conflito-base-cab { background: rgba(96, 96, 96, 0.4); }
.kora-conflito-base { background: rgba(96, 96, 96, 0.16); }
.kora-conflito-rotulo { opacity: 0.7; font-style: italic; }
`

const RULER_CURRENT = 'rgba(64, 200, 174, 0.8)'
const RULER_INCOMING = 'rgba(64, 166, 255, 0.8)'

function line(n: number, className: string, label?: string, ruler?: string): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(n, 1, n, 1),
    options: {
      isWholeLine: true,
      className,
      ...(label && { after: { content: label, inlineClassName: 'kora-conflito-rotulo' } }),
      ...(ruler && { overviewRuler: { color: ruler, position: monaco.editor.OverviewRulerLane.Full } })
    }
  }
}

function range(start: number, end: number, className: string, ruler?: string): monaco.editor.IModelDeltaDecoration[] {
  if (end < start) return []
  return [
    {
      range: new monaco.Range(start, 1, end, 1),
      options: { isWholeLine: true, className, ...(ruler && { overviewRuler: { color: ruler, position: monaco.editor.OverviewRulerLane.Full } }) }
    }
  ]
}

function decorationsFor(blocks: ConflictBlock[]): monaco.editor.IModelDeltaDecoration[] {
  return blocks.flatMap((b) => [
    line(b.startLine, 'kora-conflito-atual-cab', ' (Alteração atual)', RULER_CURRENT),
    ...range(b.current.start, b.current.end, 'kora-conflito-atual', RULER_CURRENT),
    ...(b.baseLine !== null && b.base ? [line(b.baseLine, 'kora-conflito-base-cab', ' (Base comum)'), ...range(b.base.start, b.base.end, 'kora-conflito-base')] : []),
    ...range(b.incoming.start, b.incoming.end, 'kora-conflito-entrada', RULER_INCOMING),
    line(b.endLine, 'kora-conflito-entrada-cab', ' (Alteração de entrada)', RULER_INCOMING)
  ])
}

function track(model: monaco.editor.ITextModel): void {
  if (!editable(model)) return
  let ids: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const update = (): void => {
    timer = undefined
    if (model.isDisposed()) return
    const blocks = blocksOf(model)
    if (blocks.length === 0 && ids.length === 0) return
    ids = model.deltaDecorations(ids, decorationsFor(blocks))
  }
  update()
  const change = model.onDidChangeContent(() => {
    clearTimeout(timer)
    timer = setTimeout(update, DEBOUNCE_MS)
  })
  model.onWillDispose(() => {
    clearTimeout(timer)
    change.dispose()
  })
}

// O bloco é achado de novo pela linha do "<<<<<<<" no conteúdo de agora: a lente pode ter sido calculada antes da
// última edição.
function blockAt(model: monaco.editor.ITextModel, startLine: number): ConflictBlock | undefined {
  return blocksOf(model).find((b) => b.startLine === startLine)
}

function accept(model: monaco.editor.ITextModel, startLine: number, choice: ConflictChoice): void {
  const block = blockAt(model, startLine)
  if (!block) return
  const edit = resolutionEdit(model.getLinesContent(), block, choice, model.getEOL())
  // Unidade própria na pilha de desfazer: um Ctrl+Z volta o bloco inteiro com os marcadores.
  model.pushStackElement()
  model.pushEditOperations(
    [],
    [{ range: new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn), text: edit.text }],
    () => null
  )
  model.pushStackElement()
}

const fileName = (model: monaco.editor.ITextModel): string => decodeURIComponent(model.uri.path.split('/').pop() ?? '')

// O arquivo inteiro com todos os blocos no lado atual × no lado de entrada, num diff só leitura por cima do app.
function compare(model: monaco.editor.ITextModel): void {
  const text = model.getValue()
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6 backdrop-blur-[1px]'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.innerHTML = `
    <div class="flex h-full max-h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl">
      <div class="flex h-9 shrink-0 items-center gap-3 border-b px-3 text-xs">
        <span data-titulo class="min-w-0 flex-1 truncate font-medium"></span>
        <button data-fechar type="button" class="rounded-md px-2 py-1 text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Fechar</button>
      </div>
      <div data-diff class="min-h-0 flex-1"></div>
    </div>`
  const title = overlay.querySelector<HTMLElement>('[data-titulo]')!
  const host = overlay.querySelector<HTMLElement>('[data-diff]')!
  title.textContent = `${fileName(model)}: Alteração atual ↔ Alteração de entrada`
  document.body.appendChild(overlay)

  const original = monaco.editor.createModel(resolveAll(text, 'current'), model.getLanguageId())
  const modified = monaco.editor.createModel(resolveAll(text, 'incoming'), model.getLanguageId())
  const editor = monaco.editor.createDiffEditor(host, {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: 13
  })
  editor.setModel({ original, modified })

  const close = (): void => {
    window.removeEventListener('keydown', onKey, true)
    editor.dispose()
    original.dispose()
    modified.dispose()
    overlay.remove()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close()
  }
  window.addEventListener('keydown', onKey, true)
  overlay.querySelector('[data-fechar]')!.addEventListener('click', close)
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close())
}

let registered = false

export function registerConflictSupport(): void {
  if (registered) return
  registered = true
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  monaco.editor.registerCommand(ACCEPT, (_accessor, uri: string, startLine: number, choice: ConflictChoice) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (model && !model.isDisposed()) accept(model, startLine, choice)
  })
  monaco.editor.registerCommand(COMPARE, (_accessor, uri: string) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri))
    if (model && !model.isDisposed()) compare(model)
  })

  monaco.languages.registerCodeLensProvider('*', {
    provideCodeLenses(model) {
      if (!editable(model)) return { lenses: [], dispose() {} }
      const uri = model.uri.toString()
      const lenses = blocksOf(model).flatMap((b): monaco.languages.CodeLens[] => {
        const at = new monaco.Range(b.startLine, 1, b.startLine, 1)
        const lens = (title: string, choice: ConflictChoice): monaco.languages.CodeLens => ({
          range: at,
          command: { id: ACCEPT, title, arguments: [uri, b.startLine, choice] }
        })
        return [
          lens('Aceitar alteração atual', 'current'),
          lens('Aceitar alteração de entrada', 'incoming'),
          lens('Aceitar ambas as alterações', 'both'),
          { range: at, command: { id: COMPARE, title: 'Comparar alterações', arguments: [uri] } }
        ]
      })
      return { lenses, dispose() {} }
    }
  })

  for (const model of monaco.editor.getModels()) track(model)
  monaco.editor.onDidCreateModel(track)
}
