import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, parse, resolve } from 'node:path'

// shell.trashItem não devolve onde o item foi parar. Cada item na Lixeira vira um par em
// <unidade>\$Recycle.Bin\<SID do usuário>: "$R…" é o próprio item e "$I…" guarda o caminho original e a hora da exclusão.
// Restaurar é renomear o $R de volta e apagar o $I, o mesmo que o Explorer faz no "Restaurar".
const FILETIME_EPOCH_MS = 11644473600000n

export interface TrashedItem {
  info: string
  data: string
  original: string
  deletedMs: number
}

// v1 (Vista a 8.1): caminho UTF-16 de tamanho fixo a partir do byte 24. v2 (Windows 10+): no byte 24 vem o tamanho
// do caminho em caracteres, com o terminador, e o caminho começa no 28.
export function parseRecycleInfo(buf: Buffer): { original: string; deletedMs: number } | null {
  if (buf.length < 28) return null
  const version = buf.readBigInt64LE(0)
  const deletedMs = Number(buf.readBigInt64LE(16) / 10000n - FILETIME_EPOCH_MS)
  let original: string
  if (version === 2n) {
    const chars = buf.readInt32LE(24)
    if (chars < 1 || 28 + chars * 2 > buf.length) return null
    original = buf.subarray(28, 28 + (chars - 1) * 2).toString('utf16le')
  } else if (version === 1n) {
    original = buf.subarray(24).toString('utf16le').split('\0')[0] ?? ''
  } else return null
  return original ? { original, deletedMs } : null
}

// Só a pasta do próprio usuário é legível; as dos outros usuários dão acesso negado e ficam de fora.
function trashedOnDrive(driveRoot: string): TrashedItem[] {
  const bin = join(driveRoot, '$Recycle.Bin')
  let users: string[]
  try {
    users = readdirSync(bin)
  } catch {
    return []
  }
  const items: TrashedItem[] = []
  for (const user of users) {
    let names: string[]
    try {
      names = readdirSync(join(bin, user))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('$I')) continue
      try {
        const parsed = parseRecycleInfo(readFileSync(join(bin, user, name)))
        if (parsed) items.push({ ...parsed, info: join(bin, user, name), data: join(bin, user, `$R${name.slice(2)}`) })
      } catch {
        // $I sumindo no meio da leitura (Lixeira esvaziada agora): não é o item procurado.
      }
    }
  }
  return items
}

// A pasta de cima continua existindo: o caminho real dela cobre nome curto (EDUARD~1), maiúsculas diferentes e
// junção ou ponto de montagem no meio do caminho.
export function realLocation(path: string): string {
  const full = resolve(path)
  try {
    return join(realpathSync.native(dirname(full)), basename(full))
  } catch {
    return full
  }
}

function sameOriginal(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase() || realLocation(a).toLowerCase() === realLocation(b).toLowerCase()
}

// O Windows põe o item na Lixeira do volume onde ele está de fato: projeto aberto por uma junção em C: com o conteúdo
// em D: vai para D:\$Recycle.Bin, e o $I guarda o caminho pela junção. A raiz do caminho como foi escrito fica de
// reserva para o que o realpath não resolve para uma letra (compartilhamento, volume sem letra).
export function recycleBinRoots(original: string): string[] {
  const roots = [parse(realLocation(original)).root, parse(resolve(original)).root]
  return roots.filter((root, i) => roots.findIndex((other) => other.toLowerCase() === root.toLowerCase()) === i)
}

// O relógio do Windows e o Date.now() são o mesmo; a folga cobre só arredondamento.
const SLACK_MS = 1000

// `since` é marcado antes de pedir a exclusão, então o item dela é o primeiro excluído a partir de `since` (os
// posteriores são exclusões seguintes do mesmo nome). Só sem nenhum assim vale a folga, e nela o mais recente:
// uma exclusão anterior do mesmo caminho, poucos ms antes, cairia na folga e traria de volta a versão velha.
export function chooseTrashed<T extends { deletedMs: number }>(candidates: T[], since: number): T | null {
  const after = candidates.filter((item) => item.deletedMs >= since).sort((a, b) => a.deletedMs - b.deletedMs)
  if (after[0]) return after[0]
  const rounded = candidates.filter((item) => item.deletedMs >= since - SLACK_MS).sort((a, b) => b.deletedMs - a.deletedMs)
  return rounded[0] ?? null
}

export function findTrashed(original: string, since: number): TrashedItem | null {
  return chooseTrashed(
    recycleBinRoots(original)
      .flatMap((root) => trashedOnDrive(root))
      .filter((item) => sameOriginal(item.original, original)),
    since
  )
}

export function restoreTrashed(item: TrashedItem): void {
  if (existsSync(item.original)) throw new Error(`Já existe algo em ${item.original}.`)
  renameSync(item.data, item.original)
  try {
    unlinkSync(item.info)
  } catch {
    // O item já voltou para o projeto; um $I que sobrar não muda nada nele.
  }
}
