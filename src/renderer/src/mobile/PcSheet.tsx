import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { AgentIcon, agentLabel } from '@/components/AgentIcon'
import { expiryText, weeklyText } from '@/components/ClaudeAccounts'
import { Bar, claudeWeekly } from '@/components/UsageMeter'
import { formatResetAt, formatResetIn, isCritical } from '@shared/usage-format'
import type { Alerts, ThemePreference } from '@shared/state'
import type { IconName } from '@/brand/icons'
import type { MobileUsage } from '@shared/mobile'
import { api, koraApp } from './api'
import { Loading } from './Loading'

export type PcView = 'usage' | 'settings'

export function PcSheet({ view, themes, theme, onTheme, alerts, connected, onClose, onSwitchAccount, onAlerts, onError }: {
  view: PcView
  themes: { theme: ThemePreference; label: string; icon: IconName }[]
  theme: ThemePreference
  onTheme(theme: ThemePreference): void
  alerts: Alerts
  connected: boolean
  onClose(): void
  onSwitchAccount(id: string): Promise<void>
  onAlerts(alerts: Alerts): Promise<void>
  onError(message: string): void
}): React.JSX.Element {
  const [data, setData] = useState<MobileUsage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [device, setDevice] = useState<{ id: string; name: string } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [pcName, setPcName] = useState<string | null>(null)
  const now = Date.now()
  const load = useCallback(() => api<MobileUsage>('usage').then(setData, (error: Error) => onError(error.message)), [onError])
  useEffect(() => { if (view === 'usage') void load() }, [view, load])
  useEffect(() => {
    if (view !== 'settings') return
    void api<{ id: string; name: string }>('device').then(setDevice, (error: Error) => onError(error.message))
    void fetch('/health').then((response) => response.json()).then((health: { name?: string; edition?: string }) => setPcName(health.name ? `${health.name}${health.edition === 'dev' ? ' (Dev)' : ''}` : null), () => {})
  }, [view, onError])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const run = async (key: string, task: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try { await task() } catch (error) { onError(error instanceof Error ? error.message : String(error)) } finally { setBusy(null) }
  }
  const claude = data?.usage.find((usage) => usage.agent === 'claude')
  const liveWeekly = claude ? claudeWeekly(claude) : null
  return <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="action-sheet pc-sheet" role="dialog" aria-modal="true" aria-labelledby="pc-title"><div className="sheet-handle" /><header className="sheet-header"><div><span className="eyebrow">{view === 'usage' ? 'SEU COMPUTADOR' : 'KORA NO CELULAR'}</span><h1 id="pc-title">{view === 'usage' ? 'Uso e conta' : 'Configurações'}</h1></div><button className="icon-button" aria-label="Fechar" onClick={onClose}><Icon name="fechar" /></button></header>
    <div className="pc-body">
      {view === 'usage' ? <>
      <section aria-labelledby="usage-title">
        <div className="pc-heading"><h2 id="usage-title">Limites de uso</h2><button className="icon-button" aria-label="Atualizar limites" disabled={busy !== null} onClick={() => void run('usage', load)}><Icon name="atualizar" /></button></div>
        {!data ? <Loading size={40} /> : data.usage.length === 0 ? <p className="empty-copy">Nenhum dado de uso do Claude Code nem do Codex no PC.</p> : data.usage.map((usage) => <div className="usage-agent" key={usage.agent}>
          <div className="usage-agent-name"><AgentIcon kind={usage.agent} /><strong>{agentLabel(usage.agent)}</strong>{usage.account && <small>{usage.account}</small>}</div>
          {usage.error && <p className="error">{usage.error}</p>}
          {usage.windows.map((limit) => <div className="usage-window" key={limit.label}>
            <div><span>{limit.label}</span><span className={isCritical(limit.usedPercent) ? 'error' : ''}>{Math.round(limit.usedPercent)}% usado</span></div>
            <Bar percent={limit.usedPercent} className="h-1.5 w-full" />
            <small>{limit.resetsAt === null ? 'Sem reset pendente' : `Reseta ${formatResetIn(limit.resetsAt - now)} · ${formatResetAt(limit.resetsAt, now)}`}</small>
          </div>)}
        </div>)}
      </section>
      <section aria-labelledby="account-title">
        <div className="pc-heading"><h2 id="account-title">Conta do Claude</h2></div>
        <p className="pc-note">Trocar muda o login do Claude Code no computador todo; os Claude abertos depois disso usam a conta escolhida.</p>
        {data?.accounts.map((account) => {
          const expiry = expiryText(account, now)
          const weekly = weeklyText((account.active ? liveWeekly : null) ?? account.weekly, now)
          return <button key={account.id} className="action-row account-row" aria-pressed={account.active} disabled={account.active || busy !== null || !connected || expiry.tone === 'expired'} onClick={() => void run(account.id, () => onSwitchAccount(account.id).then(load))}>
            <span className="account-check">{account.active && <Icon name="ok" />}</span>
            <span><strong>{busy === account.id ? 'Trocando…' : account.email}</strong><small className={weekly.critical ? 'error' : ''}>{weekly.text}</small>{expiry.text && <small className={expiry.tone === 'warn' ? 'warn' : 'error'}>{expiry.text}{expiry.tone === 'expired' ? ' · entre de novo pelo PC' : ''}</small>}</span>
          </button>
        })}
        {data && data.accounts.length === 0 && <p className="empty-copy">Nenhuma conta guardada no Kora. Entre numa conta pelo PC, no rodapé de limites.</p>}
        {data?.activeUnknown && <p className="pc-note">O login atual do Claude Code não foi identificado. Abra o Claude uma vez para renovar.</p>}
      </section>
      </> : <>
      {/* A lista de PCs, renomear e esquecer ficam numa tela do app, igual em qualquer Kora: aqui só o PC desta página. */}
      <section aria-labelledby="pc-connected-title">
        <div className="pc-heading"><h2 id="pc-connected-title">PC conectado</h2></div>
        <div className="pc-connected"><span className={`connection-dot ${connected ? 'online' : ''}`} aria-hidden="true" /><span><strong>{pcName ?? 'Seu PC'}</strong><small>{connected ? 'Conectado' : 'Reconectando…'}</small></span></div>
        {koraApp() && <button className="action-row" onClick={() => koraApp()!.escolherPc()}><Icon name="buscar" />Trocar de PC<Icon name="expandir" /></button>}
      </section>
      <section aria-labelledby="theme-title">
        <div className="pc-heading"><h2 id="theme-title">Aparência</h2></div>
        <p className="pc-note">Vale só para este celular; em Sistema, segue o tema do celular.</p>
        <div className="theme-choice" role="group" aria-label="Tema do celular">
          {themes.map((option) => <button key={option.theme} aria-pressed={theme === option.theme} onClick={() => onTheme(option.theme)}><Icon name={option.icon} />{option.label}</button>)}
        </div>
      </section>
      <section aria-labelledby="alerts-title">
        <div className="pc-heading"><h2 id="alerts-title">Avisos no PC</h2></div>
        <p className="pc-note">Quando uma sessão para e fica esperando você.</p>
        {([['sound', 'Som'], ['windowsNotification', 'Notificação do Windows']] as const).map(([key, label]) => <button key={key} className="action-row switch-row" role="switch" aria-checked={alerts[key]} disabled={busy !== null || !connected} onClick={() => void run(key, () => onAlerts({ ...alerts, [key]: !alerts[key] }))}>
          <span>{label}</span><span className="switch" aria-hidden="true" />
        </button>)}
      </section>
      <section aria-labelledby="device-title">
        <div className="pc-heading"><h2 id="device-title">Este celular</h2></div>
        <p className="pc-note">É o nome que aparece no PC, em Configurações → Celular.</p>
        {draft !== null ? <form className="device-rename" onSubmit={(event) => {
          event.preventDefault()
          const name = draft.trim()
          if (!name) return
          void run('device', async () => { setDevice(await api<{ id: string; name: string }>('device', { name })); setDraft(null) })
        }}>
          <input aria-label="Nome deste celular" autoFocus maxLength={60} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="button" onClick={() => setDraft(null)}>Cancelar</button>
          <button className="primary" disabled={busy !== null || !draft.trim()}>Salvar</button>
        </form> : <button className="action-row" disabled={!device || busy !== null} onClick={() => setDraft(device?.name ?? '')}><Icon name="editar" /><span className="device-name">{device?.name ?? 'Carregando…'}</span><small>Renomear</small></button>}
      </section>
      {koraApp()?.buscarAtualizacao && <section aria-labelledby="app-title">
        <div className="pc-heading"><h2 id="app-title">App do celular</h2></div>
        <p className="pc-note">As versões novas do app vêm junto com o Kora do PC.</p>
        <button className="action-row" onClick={() => koraApp()!.buscarAtualizacao!()}><Icon name="atualizar" /><span className="device-name">Buscar atualização</span><small>Versão {koraApp()!.versao?.() ?? '?'}</small></button>
      </section>}
      </>}
    </div>
  </section></div>
}
