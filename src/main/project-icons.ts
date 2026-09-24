import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { net } from 'electron'
import { findProjectIcon, githubAvatarUrl, MAX_ICON_BYTES } from './project-icon'

// A CSP do renderer só aceita imagem local/data:, então o avatar do GitHub é baixado aqui e vira data URL.
async function downloadAvatar(url: string): Promise<string | null> {
  try {
    const res = await net.fetch(url, { redirect: 'follow' })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !type.startsWith('image/')) return null
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > MAX_ICON_BYTES) return null
    return `data:${type.split(';')[0]};base64,${body.toString('base64')}`
  } catch {
    return null
  }
}

async function discover(path: string): Promise<string | null> {
  const local = await findProjectIcon(path)
  if (local) return local.dataUrl
  const avatar = await githubAvatarUrl(path)
  return avatar ? downloadAvatar(avatar) : null
}

// O ícone fica fixo em disco entre aberturas; só "Atualizar ícone" busca de novo.
// Arquivo vazio = já procurado e nada encontrado (evita refazer a busca e o download a cada início).
export class ProjectIcons {
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(private readonly dir: string) {}

  private file(projectId: string): string {
    return join(this.dir, `${projectId}.txt`)
  }

  get(projectId: string, path: string): Promise<string | null> {
    const file = this.file(projectId)
    if (existsSync(file)) return Promise.resolve(readFileSync(file, 'utf8') || null)
    return this.refresh(projectId, path)
  }

  refresh(projectId: string, path: string): Promise<string | null> {
    let job = this.pending.get(projectId)
    if (!job) {
      job = discover(path)
        .then((icon) => {
          mkdirSync(this.dir, { recursive: true })
          const file = this.file(projectId)
          writeFileSync(`${file}.tmp`, icon ?? '', 'utf8')
          renameSync(`${file}.tmp`, file)
          return icon
        })
        .finally(() => this.pending.delete(projectId))
      this.pending.set(projectId, job)
    }
    return job
  }
}
