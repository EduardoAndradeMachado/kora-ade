// O Claude Code transforma em anexo de imagem todo colar cujo texto é um caminho absoluto de imagem (.png, .jpg,
// .gif, .webp): é o que faz arrastar e Ctrl+V de print virarem imagem. O "Copiar caminho" do Kora deve colar o
// caminho como texto, então o terminal precisa saber que o texto da área de transferência veio dele: aí ele é
// enviado como digitação, que o Claude não converte (só trata como colar trechos de mais de 800 caracteres).
let lastCopiedPath: string | null = null

export function copyPath(path: string): Promise<void> {
  lastCopiedPath = path
  return navigator.clipboard.writeText(path)
}

export const isCopiedPath = (text: string): boolean => lastCopiedPath !== null && text === lastCopiedPath
