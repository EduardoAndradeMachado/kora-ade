import { describe, expect, it } from 'vitest'
import { decodeAssocString, defaultAppFor, windowsExtension } from '../src/main/file-assoc'

// Saídas do AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR_FRIENDLYAPPNAME) capturadas no PC do Eduardo
// em 2026-11-15: hr, pcchOut e o buffer de saída como veio.
const CAPTURED = {
  wav: { hr: 0, length: 38, hex: '5600650072007300e3006f00200050007200e900760069006100200064006f002000570069006e0064006f007700730020004d006500640069006100200050006c0061007900650072000000' },
  png: { hr: 0, length: 6, hex: '46006f0074006f0073000000' },
  docx: { hr: 2147943555, length: 512, hex: '' }
}

function buffer(hex: string): Uint16Array {
  const out = new Uint16Array(512)
  const bytes = Buffer.from(hex, 'hex')
  out.set(new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2))
  return out
}

describe('decodeAssocString', () => {
  it('lê o nome com acento e sem o terminador nulo', () => {
    const { hr, length, hex } = CAPTURED.wav
    expect(decodeAssocString(hr, buffer(hex), length)).toBe('Versão Prévia do Windows Media Player')
  })

  it('devolve o nome legível de app da Loja, não o ProgId AppX', () => {
    const { hr, length, hex } = CAPTURED.png
    expect(decodeAssocString(hr, buffer(hex), length)).toBe('Fotos')
  })

  it('devolve null quando o Windows diz que não há associação', () => {
    const { hr, length, hex } = CAPTURED.docx
    expect(decodeAssocString(hr, buffer(hex), length)).toBeNull()
  })
})

describe('windowsExtension', () => {
  it('segue o Windows: .env é extensão, Makefile e "nome." não têm', () => {
    expect(windowsExtension('config\\.env')).toBe('.env')
    expect(windowsExtension('docs/Relatório.DOCX')).toBe('.docx')
    expect(windowsExtension('Makefile')).toBeNull()
    expect(windowsExtension('nome.')).toBeNull()
  })
})

describe.runIf(process.platform === 'win32')('defaultAppFor no Windows de verdade', () => {
  it('extensão que nenhum programa registra não tem programa (e não "Selecionar um aplicativo")', async () => {
    expect(await defaultAppFor(`x.kora-sem-programa-${process.pid}`)).toBeNull()
  })

  it('.txt tem programa em qualquer Windows', async () => {
    expect(await defaultAppFor('notas.TXT')).toMatch(/\S/)
  })
})
