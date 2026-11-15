// Tipos que o navegador mostra a partir de um link file://. O resto (docx, zip, mp4, csv, md...) o Chrome só baixa,
// então "Abrir no navegador padrão" não aparece para eles.
const SHOWN_BY_BROWSER = new Set([
  'html', 'htm', 'xhtml', 'svg', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'json', 'txt', 'xml'
])

export function opensInBrowser(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 && SHOWN_BY_BROWSER.has(name.slice(dot + 1).toLowerCase())
}
