import { z } from 'zod'
import { AgentSessionSchema, type AgentActivity } from './agent'
import type { Alerts, KoraState, SavedTab } from './state'
import type { AgentUsage } from './usage-types'
import type { ClaudeAccountsView } from './claude-accounts'
import type { FileEntry } from './ipc'
import type { GitFile } from './git-types'

const id = z.string().min(1).max(100)
const size = { cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }
export const MobileCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add-project'), path: z.string().trim().min(1).max(4096) }),
  z.object({ type: z.literal('relocate-project'), projectId: id, path: z.string().trim().min(1).max(4096) }),
  z.object({ type: z.literal('create'), projectId: id, kind: z.enum(['claude', 'codex', 'opencode', 'shell']), ...size }),
  z.object({ type: z.literal('open-session'), projectId: id, agent: AgentSessionSchema, ...size }),
  z.object({ type: z.literal('attach'), tabId: id, ...size }),
  z.object({ type: z.literal('detach'), tabId: id }),
  z.object({ type: z.literal('resize'), tabId: id, ...size }),
  z.object({ type: z.literal('keys'), tabId: id, data: z.string().min(1).max(64) }),
  // images: caminhos devolvidos por /api/image; cada um vai numa colagem só dele (Terminals.submit).
  z.object({ type: z.literal('send'), tabId: id, text: z.string().max(32768), images: z.array(z.string().min(1).max(4096)).max(10).default([]) })
    .refine((command) => command.text.trim() !== '' || command.images.length > 0, 'Escreva uma mensagem ou anexe uma imagem.'),
  z.object({ type: z.literal('resume'), tabId: id, ...size }),
  z.object({ type: z.literal('suspend'), tabId: id }),
  z.object({ type: z.literal('close'), tabId: id }),
  z.object({ type: z.literal('rename'), tabId: id, title: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal('switch-account'), accountId: id }),
  z.object({ type: z.literal('alerts'), alerts: z.object({ sound: z.boolean(), windowsNotification: z.boolean() }) })
])
export type MobileCommand = z.infer<typeof MobileCommandSchema>
export interface TerminalSnapshot { data: string; sequence: number; cols: number; rows: number }
export const DESKTOP = 'desktop'
// holder: a tela cujo tamanho o terminal está usando (DESKTOP ou o id do celular).
export interface TerminalSizeEvent { id: string; cols: number; rows: number; holder: string }
export interface MobileTab extends SavedTab { live: boolean; activity: AgentActivity | null; holder: string | null }
export interface MobileState {
  projects: KoraState['projects']
  groups: KoraState['groups']
  missingProjectIds: string[]
  theme: KoraState['settings']['theme']
  alerts: Alerts
  tabs: MobileTab[]
}
// Login e remoção de conta ficam no PC: os dois abrem o navegador de lá.
export interface MobileUsage { usage: AgentUsage[]; accounts: ClaudeAccountsView['accounts']; activeUnknown: boolean }
// Uma pasta do projeto, como o explorador do PC mostra. O status do git vem à parte (MobileGit), uma vez por visita:
// o git status do projeto inteiro leva centenas de ms, e a pasta não precisa esperar por ele.
export interface MobileDirectory { path: string; entries: FileEntry[] }
export interface MobileGit { files: GitFile[] }
// Um pouco acima do limite de leitura (5 MB), para um arquivo no limite ainda poder crescer ao ser editado.
export const FileSaveSchema = z.object({ projectId: id, path: z.string().max(4096), content: z.string().max(6 * 1024 * 1024), mtimeMs: z.number() })
export interface MobileFolders {
  path: string
  parent: string | null
  folders: { name: string; path: string }[]
  shortcuts: { name: string; path: string }[]
}
// O nome é conferido no PC (validateEntryName), com a mesma mensagem que o explorador do PC mostra.
export const FolderCreateSchema = z.object({ parent: z.string().min(1).max(4096), name: z.string().max(255) })
export interface DesktopSessionState { state: KoraState; tabs: MobileTab[] }
// online: o celular está com o Kora aberto agora (ligado ao PC pelo fluxo de eventos).
export interface MobileDevice { id: string; name: string; pairedAt: string; online: boolean }
export interface MobileStatus {
  enabled: boolean
  // O PC tem um endereço de rede local que o celular alcança; sem ele não dá para parear.
  network: boolean
  // Fora de casa: como está a conexão do PC com o relay; null com ele desligado.
  remote?: { state: 'conectando' | 'conectado' | 'reconectando' | 'parado'; since: number; error: string | null } | null
  devices: MobileDevice[]
}
export interface MobilePairing { url: string; qr: string; expiresAt: string }
export const DeviceNameSchema = z.string().trim().min(1).max(60)
