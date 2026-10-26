import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// O EasyPanel aceita o Dockerfile como fonte do serviço. Este script troca os COPY do Dockerfile por blocos com o
// conteúdo dos arquivos, para publicar o relay sem depender do repositório no GitHub. Uso: node relay/inline-dockerfile.ts
const dir = import.meta.dirname
const DELIMITER = 'KORA_RELAY_FILE'

const inline = (file: string): string => {
  const content = readFileSync(join(dir, file), 'utf8').replaceAll('\r\n', '\n')
  if (content.split('\n').includes(DELIMITER)) throw new Error(`${file} contém a linha ${DELIMITER}`)
  return `COPY <<"${DELIMITER}" ${file}\n${content.endsWith('\n') ? content : `${content}\n`}${DELIMITER}`
}

const dockerfile = readFileSync(join(dir, 'Dockerfile'), 'utf8').replaceAll('\r\n', '\n')
  .replace(/^COPY (.+) \.\/$/gm, (_line, files: string) => files.split(/\s+/).map(inline).join('\n'))
if (/^COPY (?!<<)/m.test(dockerfile)) throw new Error('Sobrou um COPY de arquivo do disco no Dockerfile.')
process.stdout.write(`# syntax=docker/dockerfile:1\n${dockerfile}`)
