// Argumentos que chegam do renderer pelos canais fs:* e git:*. Converter com String() transformava um null vindo de
// um bug do renderer em texto de verdade: renomear para null criava o arquivo "null". Aqui o tipo errado é recusado
// na entrada, com o nome do argumento na mensagem, e o valor certo passa intacto.

const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'lista' : typeof value === 'string' ? 'texto vazio' : typeof value

const invalid = (label: string, expected: string, value: unknown): Error =>
  new Error(`Pedido inválido: ${label} precisa ser ${expected} (veio ${describe(value)}).`)

// Caminho relativo ao projeto: '' é a raiz, e quem recebe decide se a raiz vale ali.
export function pathArg(value: unknown, label = 'o caminho'): string {
  if (typeof value !== 'string') throw invalid(label, 'texto', value)
  return value
}

// Hash, revisão, trecho, branch escolhida da lista: quem recebe não tem mensagem própria para o vazio.
export function nameArg(value: unknown, label = 'o nome'): string {
  if (typeof value !== 'string' || value === '') throw invalid(label, 'texto não vazio', value)
  return value
}

// Texto livre, ou nome que quem recebe já valida com mensagem própria (arquivo, branch nova): só o tipo.
export function textArg(value: unknown, label = 'o texto'): string {
  if (typeof value !== 'string') throw invalid(label, 'texto', value)
  return value
}

export function pathListArg(value: unknown, label = 'a lista de caminhos'): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw invalid(label, 'uma lista de textos', value)
  return value
}

export function numberArg(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(label, 'um número', value)
  return value
}
