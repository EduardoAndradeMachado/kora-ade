import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyState, stepValue, TERMINAL_FONT, ZOOM } from '../src/shared/state'
import { loadState, saveState } from '../src/main/store'

describe('zoom da interface, texto do terminal e texto dos arquivos', () => {
  it('aumenta e diminui de passo em passo sem acumular erro de ponto flutuante', () => {
    let z = ZOOM.default
    for (let i = 0; i < 2; i++) z = stepValue(z, 1, ZOOM)
    expect(z).toBe(1.2)
    expect(stepValue(1.2, -1, ZOOM)).toBe(1.1)
    expect(stepValue(14, 1, TERMINAL_FONT)).toBe(15)
  })

  it('para nos limites em vez de passar deles', () => {
    expect(stepValue(ZOOM.max, 1, ZOOM)).toBe(ZOOM.max)
    expect(stepValue(ZOOM.min, -1, ZOOM)).toBe(ZOOM.min)
    expect(stepValue(TERMINAL_FONT.max, 1, TERMINAL_FONT)).toBe(TERMINAL_FONT.max)
  })

  it('zero volta ao padrão', () => {
    expect(stepValue(1.4, 0, ZOOM)).toBe(1)
    expect(stepValue(22, 0, TERMINAL_FONT)).toBe(14)
  })

  it('valores escolhidos sobrevivem ao reabrir; valor fora do limite no arquivo vira o padrão', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kora-settings-')), 'kora-state.json')
    saveState(file, { ...emptyState(), settings: { ...emptyState().settings, zoom: 1.3, terminalFontSize: 18, fileFontSize: 16 } })
    expect(loadState(file).settings).toMatchObject({ zoom: 1.3, terminalFontSize: 18, fileFontSize: 16 })

    writeFileSync(
      file,
      JSON.stringify({ version: 2, projects: [], tabs: [], settings: { theme: 'dark', zoom: 9, terminalFontSize: 3, fileFontSize: 99 } })
    )
    expect(loadState(file).settings).toEqual({ theme: 'dark', zoom: 1, terminalFontSize: 14, fileFontSize: 13 })
  })

  it('estado salvo antes do texto dos arquivos existir abre com o padrão dele, sem perder os outros tamanhos', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kora-settings-')), 'kora-state.json')
    writeFileSync(file, JSON.stringify({ version: 2, projects: [], tabs: [], settings: { theme: 'light', zoom: 1.2, terminalFontSize: 16 } }))
    expect(loadState(file).settings).toEqual({ theme: 'light', zoom: 1.2, terminalFontSize: 16, fileFontSize: 13 })
  })
})
