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
  // O PC tem o Transcritor, que transcreve o áudio do microfone do app.
  dictation: boolean
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
// online: o celular está com o Kora aberto agora (ligado ao PC pelo fluxo de eventos); via: por onde (rede de casa
// ou relay). ready: o app já registrou o certificado e pode entrar de fora pelo relay.
export interface MobileDevice { id: string; name: string; pairedAt: string; online: boolean; via?: 'local' | 'relay' | null; ready?: boolean }
export interface MobileStatus {
  enabled: boolean
  // O PC tem um endereço de rede local que o celular alcança; sem ele não dá para parear.
  network: boolean
  // Fora de casa: como está a conexão do PC com o relay; null com ele desligado.
  remote?: { state: 'conectando' | 'conectado' | 'reconectando' | 'parado'; since: number; error: string | null } | null
  // Onde o celular acha o PC: endereço na rede de casa (null fora do ar), e a conta do Fora de casa em que este PC entrou
  // (admin: a conta do dono do servidor, que vê o painel).
  address?: string | null
  account?: { email: string; admin: boolean } | null
  devices: MobileDevice[]
}
// app: link e QR para baixar o app Android direto deste PC, para quem ainda não o tem (só pela rede de casa).
export interface MobilePairing { url: string; qr: string; expiresAt: string; app?: { url: string; qr: string } }
export const DeviceNameSchema = z.string().trim().min(1).max(60)

// Conta do Fora de casa (cadastro, código por e-mail, login, troca de senha). A senha passa pelo main só até o relay.
const accountEmail = z.string().trim().min(3).max(254)
const accountCode = z.string().trim().regex(/^\d{6}$/, 'O código tem 6 números.')
const accountPassword = z.string().min(1).max(128)
export const AccountActionSchema = z.discriminatedUnion('acao', [
  z.object({ acao: z.literal('cadastro'), email: accountEmail }),
  z.object({ acao: z.literal('verificar'), email: accountEmail, codigo: accountCode, senha: accountPassword }),
  z.object({ acao: z.literal('entrar'), email: accountEmail, senha: accountPassword }),
  z.object({ acao: z.literal('esqueci'), email: accountEmail }),
  z.object({ acao: z.literal('redefinir'), email: accountEmail, codigo: accountCode, senha: accountPassword })
])
export type AccountAction = z.infer<typeof AccountActionSchema>

export const AdminRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('admin:visao') }),
  z.object({ op: z.literal('admin:bloquear'), conta: z.string().uuid(), motivo: z.string().max(200).optional() }),
  z.object({ op: z.literal('admin:desbloquear'), conta: z.string().uuid() })
])
export type AdminRequest = z.infer<typeof AdminRequestSchema>

// O que o relay devolve ao admin: contas, aparelhos com consumo (total e dos últimos 30 dias) e quem está online.
export interface AdminAccount {
  id: string
  email: string
  admin: boolean
  created_at: string
  verified_at: string | null
  blocked_at: string | null
  blocked_reason: string | null
  last_login_at: string | null
}
export interface AdminDevice {
  fingerprint: string
  account_id: string
  kind: 'pc' | 'phone'
  name: string | null
  platform: string | null
  os_version: string | null
  app_version: string | null
  created_at: string
  last_seen_at: string | null
  last_ip: string | null
  bytes_in: string
  bytes_out: string
  sessions: string
  connected_seconds: string
  bytes_in_30d: string
  bytes_out_30d: string
  sessions_30d: string
  pcs: string[]
  online: boolean
}
// you: a conta de quem está olhando, que o painel mostra à parte.
export interface AdminOverview { you: string; accounts: AdminAccount[]; devices: AdminDevice[] }
