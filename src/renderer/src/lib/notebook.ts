// Leitura do .ipynb (nbformat 4) em células para desenhar, a mesma no PC (NotebookView) e no celular.

// nbformat 4: texto vem como string ou como lista de linhas.
type MultiLine = string | string[]
interface RawOutput {
  output_type?: string
  name?: string
  text?: MultiLine
  data?: Record<string, MultiLine>
  execution_count?: number | null
  ename?: string
  evalue?: string
  traceback?: string[]
}
interface RawCell {
  cell_type?: string
  source?: MultiLine
  execution_count?: number | null
  outputs?: RawOutput[]
}

export type NotebookOutput =
  | { kind: 'text'; text: string; stderr: boolean; count: number | null }
  | { kind: 'image'; src: string; count: number | null }
export type NotebookCell =
  | { type: 'markdown'; source: string }
  | { type: 'code'; source: string; count: number | null; outputs: NotebookOutput[] }
  | { type: 'raw'; source: string }
export interface Notebook {
  language: string
  cells: NotebookCell[]
}

const joined = (value: unknown): string =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string').join('') : typeof value === 'string' ? value : ''

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

function parseOutput(raw: RawOutput): NotebookOutput | null {
  const count = typeof raw.execution_count === 'number' ? raw.execution_count : null
  if (raw.output_type === 'stream') return { kind: 'text', text: joined(raw.text), stderr: raw.name === 'stderr', count: null }
  if (raw.output_type === 'error') {
    const trace = (raw.traceback ?? []).join('\n').replace(ANSI, '')
    return { kind: 'text', text: trace || `${raw.ename ?? 'Erro'}: ${raw.evalue ?? ''}`, stderr: true, count: null }
  }
  if (raw.output_type === 'execute_result' || raw.output_type === 'display_data') {
    const data = raw.data ?? {}
    for (const mime of ['image/png', 'image/jpeg']) {
      const base64 = joined(data[mime]).replace(/\s/g, '')
      if (base64 && /^[A-Za-z0-9+/]+=*$/.test(base64)) return { kind: 'image', src: `data:${mime};base64,${base64}`, count }
    }
    const text = joined(data['text/plain'])
    if (text) return { kind: 'text', text, stderr: false, count }
  }
  return null
}

function parseNotebook(text: string): Notebook {
  const nb = JSON.parse(text) as { cells?: RawCell[]; metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } } }
  if (!nb || !Array.isArray(nb.cells)) throw new Error('Formato de notebook não suportado: falta a lista "cells" (nbformat 4).')
  const language = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? 'python'
  const cells = nb.cells.map((cell): NotebookCell => {
    const source = joined(cell.source)
    if (cell.cell_type === 'markdown') return { type: 'markdown', source }
    if (cell.cell_type === 'code') {
      const outputs = (Array.isArray(cell.outputs) ? cell.outputs : []).map(parseOutput).filter((o): o is NotebookOutput => o !== null)
      return { type: 'code', source, count: typeof cell.execution_count === 'number' ? cell.execution_count : null, outputs }
    }
    return { type: 'raw', source }
  })
  return { language: language.toLowerCase(), cells }
}

export type NotebookLoad = { status: 'error'; message: string } | { status: 'ready'; notebook: Notebook }

// O BOM fica no texto que a leitura do PC devolve, e o JSON.parse o recusa.
export function loadNotebook(text: string): NotebookLoad {
  try {
    return { status: 'ready', notebook: parseNotebook(text.replace(/^﻿/, '')) }
  } catch (err) {
    const message = err instanceof SyntaxError ? `JSON inválido: ${err.message}` : (err as Error).message
    return { status: 'error', message }
  }
}
