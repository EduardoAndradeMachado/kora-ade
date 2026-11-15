import { describe, expect, it } from 'vitest'
import { viewerFor } from '../src/shared/file-kind'

describe('viewerFor', () => {
  it('toca dentro do app o áudio e o vídeo que o Chromium suporta, com extensão em qualquer caixa', () => {
    expect(viewerFor('assets\\som.mp3')).toBe('media')
    expect(viewerFor('assets/VIDEO.MP4')).toBe('media')
    expect(viewerFor('clip.MoV')).toBe('media')
  })

  it('mantém .ts como código mesmo existindo vídeo MPEG-TS com a mesma extensão', () => {
    expect(viewerFor('src\\app.ts')).toBe('code')
  })

  it('manda para o programa do Windows o vídeo que o Chromium não toca', () => {
    expect(viewerFor('filme.mkv')).toBe('external')
    expect(viewerFor('Relatório.DOCX')).toBe('external')
  })

  it('abre .ipynb como notebook', () => {
    expect(viewerFor('analise\\Notebook.IPYNB')).toBe('notebook')
  })

  it('abre CSV, TSV e .xlsx na planilha e deixa o .xls antigo com o programa do Windows', () => {
    expect(viewerFor('dados\\vendas.csv')).toBe('sheet')
    expect(viewerFor('export.TSV')).toBe('sheet')
    expect(viewerFor('Relatório.XLSX')).toBe('sheet')
    expect(viewerFor('antigo.xls')).toBe('external')
  })
})
