import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/mobile/api'

afterEach(() => vi.unstubAllGlobals())

const answer = (response: Response): void => { vi.stubGlobal('fetch', async () => response) }

it('null do PC é resposta, não falha de conexão (snapshot de aba sem terminal)', async () => {
  answer(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }))
  await expect(api('snapshot?tab=x')).resolves.toBeNull()
})

it('502 sem corpo da passagem do app vira aviso com o motivo, venha ele codificado (0.5.2) ou cru (0.5.1)', async () => {
  answer(new Response('', { status: 502, headers: { 'x-kora-erro': encodeURIComponent('O relay não respondeu a tempo.') } }))
  await expect(api('file?x')).rejects.toThrow('Sem conexão com o PC agora (O relay não respondeu a tempo). Confira a internet do celular')
  answer(new Response('', { status: 502, headers: { 'x-kora-erro': 'Falha 100% na rede' } }))
  await expect(api('file?x')).rejects.toThrow('Sem conexão com o PC agora (Falha 100% na rede).')
  answer(new Response('', { status: 502 }))
  await expect(api('file?x')).rejects.toThrow(/^Sem conexão com o PC agora\. Confira/)
})

it('403 sem corpo é a tela que perdeu o cookie da passagem; erro com JSON mostra a mensagem do PC', async () => {
  answer(new Response('', { status: 403 }))
  await expect(api('file?x')).rejects.toThrow('O app perdeu a ligação com esta tela.')
  answer(new Response(JSON.stringify({ error: 'Link vencido. Abra o arquivo de novo.' }), { status: 403 }))
  await expect(api('file?x')).rejects.toThrow('Link vencido. Abra o arquivo de novo.')
})
