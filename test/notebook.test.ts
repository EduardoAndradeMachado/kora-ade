import { describe, expect, it } from 'vitest'
import { loadNotebook } from '../src/renderer/src/lib/notebook'

const nb = (cells: unknown[], metadata: unknown = {}): string => JSON.stringify({ nbformat: 4, metadata, cells })

describe('leitura do .ipynb (PC e celular)', () => {
  it('células de Markdown, código com saídas de texto, erro e imagem; o resto das saídas fica de fora', () => {
    const load = loadNotebook('﻿' + nb([
      { cell_type: 'markdown', source: ['# Título\n', 'texto'] },
      { cell_type: 'code', execution_count: 3, source: 'print(1)', outputs: [
        { output_type: 'stream', name: 'stdout', text: ['1\n'] },
        { output_type: 'error', ename: 'ValueError', evalue: 'ruim', traceback: ['\u001b[31mValueError\u001b[0m: ruim'] },
        { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=\n' } },
        { output_type: 'display_data', data: { 'text/html': '<script>alert(1)</script>' } }
      ] },
      { cell_type: 'raw', source: 'cru' }
    ], { language_info: { name: 'Python' } }))
    expect(load.status).toBe('ready')
    if (load.status !== 'ready') return
    expect(load.notebook.language).toBe('python')
    expect(load.notebook.cells[0]).toEqual({ type: 'markdown', source: '# Título\ntexto' })
    expect(load.notebook.cells[1]).toEqual({ type: 'code', source: 'print(1)', count: 3, outputs: [
      { kind: 'text', text: '1\n', stderr: false, count: null },
      { kind: 'text', text: 'ValueError: ruim', stderr: true, count: null },
      { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', count: null }
    ] })
    expect(load.notebook.cells[2]).toEqual({ type: 'raw', source: 'cru' })
  })

  it('JSON quebrado e notebook sem células viram aviso, não exceção', () => {
    expect(loadNotebook('{"cells": [')).toMatchObject({ status: 'error', message: expect.stringMatching(/^JSON inválido/) })
    expect(loadNotebook('{"nbformat": 3}')).toMatchObject({ status: 'error', message: expect.stringContaining('"cells"') })
  })
})
