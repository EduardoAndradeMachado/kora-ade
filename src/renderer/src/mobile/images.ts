import { imageTypeOf } from '@shared/image-bytes'

const SENT_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// Print de tela costuma ficar abaixo disto e vai como está, nítido. Foto de câmera passa e é reduzida: o Claude
// reduz imagem grande de qualquer jeito, e assim a rede de casa não carrega 10 MB à toa.
const MAX_BYTES = 3 * 1024 * 1024
const MAX_SIDE = 2048

// O celular não abre como imagem (TIFF, PSD, PDF com nome de .jpg): vai como arquivo, ou não vai.
class NotAnImage extends Error {}

export async function imageForUpload(file: File): Promise<Blob> {
  const real = imageTypeOf(new Uint8Array(await file.slice(0, 12).arrayBuffer()))
  if (real && SENT_AS_IS.has(file.type) && file.size <= MAX_BYTES) return real === file.type ? file : new Blob([file], { type: real })
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) {
    if (real) return new Blob([file], { type: real })
    throw new NotAnImage('Este formato de imagem não abre no navegador do celular.')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new Error('Não deu para preparar a imagem.')
  return blob
}

// Miniatura embutida (data:), pequena: não depende de endereço blob: na política da página nem de liberar memória.
async function thumbnail(image: Blob): Promise<string> {
  const bitmap = await createImageBitmap(image).catch(() => null)
  if (!bitmap) return ''
  const scale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.8)
}

const detail = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

export async function uploadImage(file: File): Promise<{ path: string; preview: string }> {
  // A imagem da galeria do Android é um arquivo emprestado, lido só na hora do envio; se essa leitura falha, o
  // fetch diz "Failed to fetch" como se fosse a rede. Lendo antes para a memória, cada falha tem o nome certo.
  let image: Blob
  try {
    const prepared = await imageForUpload(file)
    image = new Blob([await prepared.arrayBuffer()], { type: prepared.type })
  } catch (error) {
    if (error instanceof NotAnImage) throw error
    throw new Error(`Não deu para ler a imagem no celular (${detail(error)}). Escolha de novo.`)
  }
  const path = await postToPc('/api/image', { 'content-type': image.type }, image, 'a imagem')
  return { path, preview: await thumbnail(image) }
}

async function postToPc(url: string, headers: Record<string, string>, body: Blob, what: string): Promise<string> {
  const post = (): Promise<Response> => fetch(url, { method: 'POST', headers, body })
  // Depois da tela apagada, o navegador ainda tenta a conexão antiga, que o Wi-Fi já derrubou: o envio falha na
  // rede e a segunda tentativa abre uma conexão nova. Repetir no máximo salva o arquivo duas vezes.
  const response = await post().catch(post).catch((error: unknown) => {
    // O fetch sem resposta nenhuma só diz "Failed to fetch".
    throw new Error(`Não deu para enviar ${what} ao PC (${error instanceof TypeError ? 'sem conexão com o PC' : detail(error)}).`)
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? `Não deu para enviar ${what} ao PC.`)
  // Conexão caída depois do 200 deixa o JSON pela metade: sem caminho, o anexo apareceria no campo e falharia no envio.
  if (typeof result.path !== 'string' || result.path === '') throw new Error(`Não deu para enviar ${what} ao PC (resposta incompleta). Tente de novo.`)
  return result.path
}

const MAX_FILE_BYTES = 20 * 1024 * 1024

// Arquivo que não é imagem (PDF, planilha, texto) vai como está, com o nome original: o agente lê pelo caminho.
export async function uploadFile(file: File): Promise<{ path: string; name: string }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} passa de 20 MB, o limite para anexar.`)
  let bytes: Blob
  try {
    bytes = new Blob([await file.arrayBuffer()])
  } catch (error) {
    throw new Error(`Não deu para ler o arquivo no celular (${detail(error)}). Escolha de novo.`)
  }
  const path = await postToPc('/api/attachment', { 'content-type': 'application/octet-stream', 'x-kora-filename': encodeURIComponent(file.name) }, bytes, 'o arquivo')
  return { path, name: file.name }
}

// Como o app Android até a 0.5.3 entrega qualquer arquivo escolhido: o nome e o tipo originais se perdem.
const OLD_APP_COPY = /^imagem-\d+\.(jpg|png|webp|gif)$/

export async function uploadAttachment(file: File): Promise<{ path: string; preview: string; name?: string }> {
  // SVG é texto: vai como arquivo, como PDF e planilha.
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return { ...await uploadFile(file), preview: '' }
  try {
    return await uploadImage(file)
  } catch (error) {
    if (!(error instanceof NotAnImage)) throw error
    if (OLD_APP_COPY.test(file.name)) throw new Error('Este arquivo não é imagem, e o app do celular está desatualizado para anexar outros arquivos. Atualize o app Kora no celular.')
    return { ...await uploadFile(file), preview: '' }
  }
}

// Mesmo formato do arrastar arquivo no PC: caminho com espaço vai entre aspas.
export const pathForPrompt = (path: string): string => (path.includes(' ') ? `"${path}"` : path)
