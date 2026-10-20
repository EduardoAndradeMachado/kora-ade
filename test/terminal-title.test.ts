import { describe, expect, it } from 'vitest'
import { meaningfulTitle } from '../src/shared/terminal-title'

describe('título da aba', () => {
  it('ignora o caminho do executável do shell', () => {
    expect(meaningfulTitle('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBeNull()
    expect(meaningfulTitle('C:\\WINDOWS\\system32\\cmd.exe')).toBeNull()
    expect(meaningfulTitle('   ')).toBeNull()
  })

  it('mantém títulos definidos pelo programa, como o do Claude', () => {
    expect(meaningfulTitle('✳ Refatorar login')).toBe('✳ Refatorar login')
  })

  it('tira o prefixo que o OpenCode publica e ignora o título genérico dele', () => {
    expect(meaningfulTitle('OC | Histórico do terminal')).toBe('Histórico do terminal')
    expect(meaningfulTitle('oc |Integração com OpenCode')).toBe('Integração com OpenCode')
    expect(meaningfulTitle('OpenCode')).toBeNull()
  })
})
