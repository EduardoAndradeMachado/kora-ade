const SENT_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// Print de tela costuma ficar abaixo disto e vai como está, nítido. Foto de câmera passa e é reduzida: o Claude
// reduz imagem grande de qualquer jeito, e assim a rede de casa não carrega 10 MB à toa.
const MAX_BYTES = 3 * 1024 * 1024
const MAX_SIDE = 2048

export async function imageForUpload(file: File): Promise<Blob> {
  if (SENT_AS_IS.has(file.type) && file.size <= MAX_BYTES) return file
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) {
    if (SENT_AS_IS.has(file.type)) return file
    throw new Error('Este formato de imagem não abre no navegador do celular.')
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
    throw new Error(`Não deu para ler a imagem no celular (${detail(error)}). Escolha de novo.`)
  }
  const post = (): Promise<Response> => fetch('/api/image', { method: 'POST', headers: { 'content-type': image.type }, body: image })
  // Depois da tela apagada, o navegador ainda tenta a conexão antiga, que o Wi-Fi já derrubou: o envio falha na
  // rede e a segunda tentativa abre uma conexão nova. Repetir no máximo salva o print duas vezes.
  const response = await post().catch(post).catch((error: unknown) => {
    // O fetch sem resposta nenhuma só diz "Failed to fetch".
    throw new Error(`Não deu para enviar a imagem ao PC (${error instanceof TypeError ? 'sem conexão com o PC' : detail(error)}).`)
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? 'Não deu para enviar a imagem ao PC.')
  return { path: result.path as string, preview: await thumbnail(image) }
}

// Mesmo formato do arrastar arquivo no PC: caminho com espaço vai entre aspas.
export const pathForPrompt = (path: string): string => (path.includes(' ') ? `"${path}"` : path)
