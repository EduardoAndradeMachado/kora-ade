import { describe, expect, it } from 'vitest'
import { ipcErrorMessage, isNotFound } from '../src/renderer/src/lib/ipc-error'

const fromMain = (message: string): Error => new Error(`Error invoking remote method 'fs:reveal': Error: ${message}`)

describe('mensagem de erro vinda do main', () => {
  it('tira o embrulho do ipcRenderer e mantém a mensagem do main', () => {
    expect(ipcErrorMessage(fromMain('Caminho fora do projeto'))).toBe('Caminho fora do projeto')
  })

  it('arquivo que sumiu vira uma frase legível, sem o caminho cru do ENOENT', () => {
    const err = fromMain("ENOENT: no such file or directory, stat 'C:/proj/logo.svg'")
    expect(ipcErrorMessage(err)).toBe('Esse item não existe mais: foi movido ou apagado fora do Kora.')
    expect(isNotFound(err)).toBe(true)
    expect(isNotFound(fromMain('EPERM: operation not permitted'))).toBe(false)
  })

  it('tela que abria um arquivo diz qual não foi encontrado; outro erro continua igual', () => {
    const gone = new Error(`Error invoking remote method 'fs:read': Error: ENOENT: no such file or directory, open 'C:\\proj\\src\\velho.ts'`)
    expect(ipcErrorMessage(gone, 'src\\velho.ts')).toBe('Arquivo não encontrado: src\\velho.ts')
    expect(ipcErrorMessage(fromMain('EBUSY: resource busy or locked'), 'src\\a.ts')).toBe('EBUSY: resource busy or locked')
  })
})
