import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteGenericCredential, readGenericCredential, writeGenericCredential } from '../src/main/antigravity'

// Cofre de Credenciais real do Windows, numa entrada só do teste: o que importa aqui é o CredWriteW aceitar a struct
// e o agy (go-keyring) ler de volta os mesmos bytes.
const TARGET = `kora-vitest:agy-${process.pid}`

afterEach(() => deleteGenericCredential(TARGET))

describe.runIf(process.platform === 'win32')('Cofre de Credenciais do Windows', () => {
  it('grava, lê de volta os mesmos bytes e apaga', () => {
    const raw = JSON.stringify({ token: { access_token: 'ya29.teste', refresh_token: '1//teste' }, id_token_email: 'pessoa@exemplo.com', nota: 'acentuação ✓' })
    writeGenericCredential(TARGET, 'antigravity', raw)
    expect(readGenericCredential(TARGET)).toBe(raw)

    writeGenericCredential(TARGET, 'antigravity', '{"outra":1}')
    expect(readGenericCredential(TARGET)).toBe('{"outra":1}')

    deleteGenericCredential(TARGET)
    expect(readGenericCredential(TARGET)).toBeNull()
  })

  it('apagar o que não existe não falha', () => {
    expect(() => deleteGenericCredential(TARGET)).not.toThrow()
  })

  // O go-keyring do agy procura pelo usuário e persistência que ele mesmo grava; o cmdkey mostra os dois.
  it('grava como credencial genérica, usuário antigravity e persistência local', () => {
    writeGenericCredential(TARGET, 'antigravity', '{}')
    const listed = execFileSync('cmdkey', [`/list:${TARGET}`], { encoding: 'latin1' })
    expect(listed).toContain(TARGET)
    expect(listed).toMatch(/antigravity/)
    expect(listed).toMatch(/(local|Local)/)
  })
})
