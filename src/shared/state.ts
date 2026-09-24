import { z } from 'zod'
import { AgentSessionSchema } from './agent'

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  // Oculto e categoria só mudam onde o projeto aparece na lateral; abas e sessões dele seguem iguais.
  hidden: z.boolean().optional(),
  groupId: z.string().min(1).optional()
})

export const GROUP_NAME_MAX = 60

// Categoria criada pelo usuário (ex.: uma empresa): divisória na lateral, como "Ocultos", com nome próprio.
export const ProjectGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(GROUP_NAME_MAX),
  collapsed: z.boolean().optional(),
  // Subcategoria: aponta para a categoria de cima.
  parentId: z.string().min(1).optional(),
  // Categoria inteira em Ocultos: os projetos continuam nela, e ela volta inteira ao ser mostrada.
  hidden: z.boolean().optional()
})

export const SavedTabSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string(),
  // Nome dado pelo usuário: o título que o Claude/Codex publicam no terminal não o substitui.
  titleLocked: z.boolean().default(false),
  agent: AgentSessionSchema.nullable()
})

export const ThemePreferenceSchema = z.enum(['system', 'light', 'dark'])
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>

export const ZOOM = { min: 0.7, max: 1.6, step: 0.1, default: 1 }
export const TERMINAL_FONT = { min: 10, max: 28, step: 1, default: 14 }

// toFixed: somar 0.1 várias vezes em ponto flutuante dá 1.2000000000000002.
export function stepValue(current: number, direction: 1 | -1 | 0, range: typeof ZOOM): number {
  if (direction === 0) return range.default
  const next = Number((current + direction * range.step).toFixed(2))
  return Math.min(range.max, Math.max(range.min, next))
}

const SettingsSchema = z.object({
  theme: ThemePreferenceSchema.default('system'),
  zoom: z.number().min(ZOOM.min).max(ZOOM.max).catch(ZOOM.default).default(ZOOM.default),
  terminalFontSize: z
    .number()
    .int()
    .min(TERMINAL_FONT.min)
    .max(TERMINAL_FONT.max)
    .catch(TERMINAL_FONT.default)
    .default(TERMINAL_FONT.default)
})
export type Settings = z.infer<typeof SettingsSchema>
const defaultSettings = (): Settings => ({ theme: 'system', zoom: ZOOM.default, terminalFontSize: TERMINAL_FONT.default })

const StateV1Schema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectSchema)
})

export const StateSchema = z.object({
  version: z.literal(2),
  projects: z.array(ProjectSchema),
  tabs: z.array(SavedTabSchema),
  groups: z.array(ProjectGroupSchema).default([]),
  settings: SettingsSchema.default(defaultSettings)
})

export type Project = z.infer<typeof ProjectSchema>
export type ProjectGroup = z.infer<typeof ProjectGroupSchema>
export type SavedTab = z.infer<typeof SavedTabSchema>
export type KoraState = z.infer<typeof StateSchema>

export const emptyState = (): KoraState => ({ version: 2, projects: [], tabs: [], groups: [], settings: defaultSettings() })

export function parseState(raw: unknown): KoraState {
  const v1 = StateV1Schema.safeParse(raw)
  if (v1.success) return { version: 2, projects: v1.data.projects, tabs: [], groups: [], settings: defaultSettings() }
  return StateSchema.parse(raw)
}
