import type { AgentRef } from '../shared/agent'
import { isOff } from '../shared/metrics'
import type { TranscriptPage, TranscriptStatus } from '../shared/transcript'
import { sessionMetrics, type MetricsSources } from './metrics'
import { agyTranscriptPage } from './transcript-agy'
import { codexTranscriptPage } from './transcript-codex'
import { opencodeTranscriptPage } from './transcript-opencode'
import { claudeSkills, claudeStatus, claudeTabTranscript, claudeTranscriptFile, type SkillEntry, type TranscriptCursor } from './transcript-claude'

async function metricsStatus(sources: MetricsSources, agent: AgentRef, projectPath: string): Promise<TranscriptStatus> {
  try {
    const metrics = await sessionMetrics(sources, agent, projectPath)
    const last = metrics.responses.at(-1)
    return {
      ...(last ? { model: last.model, contextTokens: last.contextTokens } : {}),
      ...(isOff(metrics.contextWindow) ? {} : { contextWindow: metrics.contextWindow })
    }
  } catch {
    // Sem métricas a barra só perde o modelo e o contexto; a conversa continua aparecendo.
    return {}
  }
}

const defined = (status: TranscriptStatus | undefined): TranscriptStatus =>
  Object.fromEntries(Object.entries(status ?? {}).filter(([, value]) => value !== undefined)) as TranscriptStatus

// A conversa de qualquer agente para o modo leitura. O status vai na primeira página e sempre que chega novidade:
// é quando o modelo, o contexto ou o modo podem ter mudado.
export async function agentTranscript(sources: MetricsSources, agent: AgentRef, projectPath: string, cursor: TranscriptCursor): Promise<TranscriptPage> {
  let page: TranscriptPage
  let extra: () => Promise<TranscriptStatus>
  switch (agent.kind) {
    case 'claude': {
      const file = await claudeTranscriptFile(sources.claudeRoot, agent.sessionId, projectPath)
      page = await claudeTabTranscript(sources.claudeRoot, agent.sessionId, projectPath, cursor)
      extra = () => claudeStatus(file)
      break
    }
    case 'codex':
      // O status (modelo, esforço, aprovação) já vem do turn_context que o leitor encontra.
      page = await codexTranscriptPage(sources.codexRollout(agent.sessionId), agent.sessionId, cursor)
      extra = async () => ({})
      break
    case 'antigravity':
      page = await agyTranscriptPage(sources.agyRoot, agent.sessionId, cursor)
      extra = async () => ({})
      break
    case 'opencode':
      page = await opencodeTranscriptPage(sources.opencodeDb, agent.sessionId, cursor)
      extra = async () => ({})
      break
    default:
      throw new Error('O modo leitura ainda não lê este agente.')
  }
  if (cursor.after === undefined || page.items.length > 0) {
    const [fromMetrics, fromAgent] = await Promise.all([metricsStatus(sources, agent, projectPath), extra()])
    page.status = { ...defined(fromMetrics), ...defined(page.status), ...defined(fromAgent) }
  }
  return page
}

// Skills que o agente anunciou na conversa, para o menu "/" do celular. Os comandos fixos de cada agente ficam
// no próprio celular (shared/agent-commands).
export async function agentSkills(sources: MetricsSources, agent: AgentRef, projectPath: string): Promise<SkillEntry[]> {
  if (agent.kind !== 'claude') return []
  return claudeSkills(await claudeTranscriptFile(sources.claudeRoot, agent.sessionId, projectPath))
}
