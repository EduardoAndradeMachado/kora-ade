import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/mobile/api'

afterEach(() => vi.unstubAllGlobals())

const answer = (response: Response): void => { vi.stubGlobal('fetch', async () => response) }

it('null do PC é resposta, não falha de conexão (snapshot de aba sem terminal)', async () => {
  answer(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }))
  await expect(api('snapshot?tab=x')).resolves.toBeNull()
})

it('502 sem corpo da passagem do app vira o aviso curto; o motivo, codificado (0.5.2) ou cru (0.5.1), vai para o console', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  answer(new Response('', { status: 502, headers: { 'x-kora-erro': encodeURIComponent('O relay não respondeu a tempo.') } }))
  await expect(api('file?x')).rejects.toThrow(/^Sem conexão com o PC\.$/)
  answer(new Response('', { status: 502, headers: { 'x-kora-erro': 'Falha 100% na rede' } }))
  await expect(api('file?x')).rejects.toThrow(/^Sem conexão com o PC\.$/)
  answer(new Response('', { status: 502 }))
  await expect(api('file?x')).rejects.toThrow(/^Sem conexão com o PC\.$/)
  expect(warn.mock.calls.map(([line]) => line)).toEqual(['[kora] sem conexão com o PC: O relay não respondeu a tempo.', '[kora] sem conexão com o PC: Falha 100% na rede'])
  warn.mockRestore()
})

it('rede que cai antes de qualquer resposta vira aviso em português, e não o "Failed to fetch" do navegador', async () => {
  vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
  await expect(api('file?x')).rejects.toThrow(/^Sem conexão com o PC\.$/)
})

it('403 sem corpo é a tela que perdeu o cookie da passagem; erro com JSON mostra a mensagem do PC', async () => {
  answer(new Response('', { status: 403 }))
  await expect(api('file?x')).rejects.toThrow('O app perdeu a ligação com esta tela.')
  answer(new Response(JSON.stringify({ error: 'Link vencido. Abra o arquivo de novo.' }), { status: 403 }))
  await expect(api('file?x')).rejects.toThrow('Link vencido. Abra o arquivo de novo.')
})
