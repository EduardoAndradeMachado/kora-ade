import { describe, expect, it } from 'vitest'
import type { editor } from 'monaco-editor'
import { isBeforeReload, trackExternalReloads } from '../src/renderer/src/lib/external-reloads'

// O TextModel de verdade do Monaco, com a pilha de desfazer de verdade: é ela que decide os números de versão que a
// regra segue. Os serviços de linguagem não entram na conta e vão como objetos vazios.
const MONACO = 'monaco-editor/'
const { TextModel } = (await import(/* @vite-ignore */ `${MONACO}editor/common/model/textModel.js`)) as {
  TextModel: (new (...args: unknown[]) => editor.ITextModel) & { DEFAULT_CREATION_OPTIONS: unknown }
}
const { UndoRedoService } = (await import(/* @vite-ignore */ `${MONACO}platform/undoRedo/common/undoRedoService.js`)) as {
  UndoRedoService: new (...args: unknown[]) => unknown
}
const inert: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' ? undefined : inert),
  apply: () => inert,
  construct: () => inert as object
})
const services = { createInstance: (Part: new (...args: unknown[]) => unknown, ...args: unknown[]) => new Part(...args, inert, inert, inert, inert) }

function openModel(text: string): editor.ITextModel {
  return new TextModel(text, 'plaintext', TextModel.DEFAULT_CREATION_OPTIONS, null, new UndoRedoService(inert, inert), inert, inert, services)
}

// Digitação seguida, sem pausa: o Monaco junta no mesmo passo de desfazer o que vier depois sem pushStackElement.
function type(model: editor.ITextModel, text: string): void {
  const end = model.getFullModelRange().getEndPosition()
  model.pushEditOperations([], [{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text }], () => null)
}

const undo = async (model: editor.ITextModel): Promise<void> => void (await model.undo())
const redo = async (model: editor.ITextModel): Promise<void> => void (await model.redo())

describe('desfazer que volta para antes da mudança feita fora do editor', () => {
  it('desfazer a recarga do agente avisa; refazer tira o aviso', async () => {
    const model = openModel('meu texto')
    const reloads = trackExternalReloads(model)
    reloads.apply('texto do agente')
    expect(reloads.isBeforeReload()).toBe(false)
    await undo(model)
    expect(model.getValue()).toBe('meu texto')
    expect(reloads.isBeforeReload()).toBe(true)
    await redo(model)
    expect(model.getValue()).toBe('texto do agente')
    expect(reloads.isBeforeReload()).toBe(false)
  })

  it('digitar logo depois da recarga e desfazer só a digitação não avisa', async () => {
    const model = openModel('a')
    const reloads = trackExternalReloads(model)
    reloads.apply('b')
    type(model, ' 1')
    model.pushStackElement()
    type(model, ' 2')
    expect(reloads.isBeforeReload()).toBe(false)
    await undo(model)
    expect(model.getValue()).toBe('b 1')
    expect(reloads.isBeforeReload()).toBe(false)
    await undo(model)
    expect(model.getValue()).toBe('b')
    expect(reloads.isBeforeReload()).toBe(false)
  })

  it('desfazer até antes e digitar por cima do texto antigo continua avisando', async () => {
    const model = openModel('antigo')
    const reloads = trackExternalReloads(model)
    reloads.apply('do agente')
    await undo(model)
    type(model, ' e mais')
    expect(model.getValue()).toBe('antigo e mais')
    expect(reloads.isBeforeReload()).toBe(true)
  })

  it('duas recargas seguidas: desfazer só a segunda já avisa', async () => {
    const model = openModel('v1')
    const reloads = trackExternalReloads(model)
    reloads.apply('v2')
    reloads.apply('v3')
    await undo(model)
    expect(model.getValue()).toBe('v2')
    expect(reloads.isBeforeReload()).toBe(true)
  })

  it('salvar por cima (confirmado) apaga o aviso; salvar depois da recarga não apaga o de um desfazer futuro', async () => {
    const model = openModel('a')
    const reloads = trackExternalReloads(model)
    reloads.apply('b')
    type(model, '!')
    reloads.saved()
    await undo(model)
    await undo(model)
    expect(model.getValue()).toBe('a')
    expect(reloads.isBeforeReload()).toBe(true)
    reloads.saved()
    expect(reloads.isBeforeReload()).toBe(false)
  })

  it('recarregar do disco com setValue zera: não há mais para onde desfazer', async () => {
    const model = openModel('a')
    const reloads = trackExternalReloads(model)
    reloads.apply('b')
    await undo(model)
    expect(reloads.isBeforeReload()).toBe(true)
    model.setValue('c')
    expect(reloads.isBeforeReload()).toBe(false)
  })

  it('sem recarga externa, desfazer as próprias edições nunca avisa', async () => {
    const model = openModel('a')
    const reloads = trackExternalReloads(model)
    type(model, 'b')
    await undo(model)
    expect(reloads.isBeforeReload()).toBe(false)
  })

  it('a subida pelos estados: descendente da recarga não avisa, o resto avisa', () => {
    const parents = new Map([
      [6, 5],
      [7, 6],
      [8, 3]
    ])
    expect(isBeforeReload(parents, 5, 5)).toBe(false)
    expect(isBeforeReload(parents, 5, 7)).toBe(false)
    expect(isBeforeReload(parents, 5, 3)).toBe(true)
    expect(isBeforeReload(parents, 5, 8)).toBe(true)
    expect(isBeforeReload(parents, null, 3)).toBe(false)
  })
})
