import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { MobileTab } from '@shared/mobile'
import type { TranscriptEvent, TranscriptItem, TranscriptPage, TranscriptStatus } from '@shared/transcript'
import { ALLOWED_URI } from '@/lib/markdown-links'
import { Icon } from '@/brand/icons'
import { api, koraApp } from './api'
import { copyWithNotice } from './CopyActions'
import { SkeletonRows } from './Skeleton'
import { ReadingStatus } from './ReadingStatus'
import { colorCodeBlocks } from './code-colors'

const PAGE = 40
// Perto do fim, a mensagem nova rola a lista até ela; mais acima, a pessoa está lendo e ganha o aviso.
const STICK_PX = 120
const WORKING_POLL_MS = 3000
const FOLLOW_RETRIES = 5
const FOLLOW_RETRY_MS = 2000

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Desde a última mensagem do usuário: o turno em andamento, como o contador do Claude no terminal.
function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="reading-elapsed">{duration(now - since)}</span>
}

// Início do turno em andamento pelo arquivo: a última mensagem do usuário, se nenhum fim de turno veio depois dela e o
// arquivo mexeu há pouco. Turno que ficou aberto (agente fechado no meio) não vira um contador de dias.
export function openTurnStart(items: TranscriptItem[], now = Date.now()): number | null {
  const lastUser = items.findLastIndex((item) => item.kind === 'user')
  if (lastUser === -1 || items.slice(lastUser).some((item) => item.kind === 'turn')) return null
  const lastAt = Date.parse(items.at(-1)!.at)
  if (!(now - lastAt < OPEN_TURN_FRESH_MS)) return null
  const start = Date.parse(items[lastUser]!.at)
  return Number.isFinite(start) ? start : null
}
const OPEN_TURN_FRESH_MS = 15 * 60_000

type Result = Extract<TranscriptItem, { kind: 'result' }>
type Tool = Extract<TranscriptItem, { kind: 'tool' }>

export function markdownMessage(text: string): string {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), { ALLOWED_URI_REGEXP: ALLOWED_URI })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const pre of doc.querySelectorAll('pre')) {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'code-copy'
    button.textContent = 'Copiar'
    pre.prepend(button)
  }
  return doc.body.innerHTML
}

const openUrl = (uri: string): void => {
  // No app, sair da página cai no shouldOverrideUrlLoading, que manda o endereço ao navegador do celular.
  if (koraApp()) location.assign(uri)
  else window.open(uri, '_blank')
}

const Assistant = memo(function Assistant({ text, truncated }: { text: string; truncated: boolean }): React.JSX.Element {
  const html = useMemo(() => markdownMessage(text), [text])
  const article = useRef<HTMLElement>(null)
  useEffect(() => { if (article.current) void colorCodeBlocks(article.current) }, [html])
  return <div className="reading-assistant">
    <article ref={article} className="markdown-view" dangerouslySetInnerHTML={{ __html: html }} />
    {truncated && <p className="reading-cut">Mensagem longa: o resto está no terminal.</p>}
    <button type="button" className="reading-copy" aria-label="Copiar resposta" onClick={() => void copyWithNotice(text, 'Resposta copiada.')}><Icon name="copiar" /></button>
  </div>
})

function ToolRow({ tool, result }: { tool: Tool; result: Result | undefined }): React.JSX.Element {
  const state = !result ? 'pending' : result.error ? 'error' : 'ok'
  return <details className={`reading-tool ${state}`}>
    <summary><span className="reading-tool-name">{tool.name}</span><span className="reading-tool-summary">{tool.summary}</span><span className="reading-tool-state" aria-label={state === 'pending' ? 'Em andamento' : state === 'error' ? 'Falhou' : 'Concluída'} /></summary>
    {result ? <pre>{result.text || '(sem saída)'}{result.truncated ? '\n…' : ''}</pre> : <p className="reading-cut">Sem resultado ainda.</p>}
  </details>
}

// O que o agente está pedindo no terminal (permissão, pergunta, plano) não vai para o arquivo até ser respondido.
// Sinal disso: a última ferramenta chamada ainda sem resultado, com o agente parado.
function pendingTool(items: TranscriptItem[], results: Map<string, Result>): Tool | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'result') continue
    return item.kind === 'tool' && !results.has(item.toolId) ? item : null
  }
  return null
}

export function ReadingView({ tab, connected, connection, feed, modelSheet, onModelSheet, onTerminal, onInterrupt, onSend, onError }: {
  tab: MobileTab
  connected: boolean
  connection: number
  feed: React.MutableRefObject<{ transcript: ((event: TranscriptEvent) => void) | null }>
  modelSheet: boolean
  onModelSheet(open: boolean): void
  onTerminal(): void
  onInterrupt(): void
  onSend(text: string, picker: boolean): void
  onError(message: string): void
}): React.JSX.Element {
  const sessionId = tab.agent?.sessionId ?? ''
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [loading, setLoading] = useState(true)
  const [older, setOlder] = useState<'idle' | 'loading' | 'done'>('idle')
  const [unseen, setUnseen] = useState(false)
  const [status, setStatus] = useState<TranscriptStatus>({})
  // Quando o celular viu o agente começar a trabalhar; null se já estava trabalhando ao abrir a conversa.
  const [workingSince, setWorkingSince] = useState<number | null>(null)
  const seenActivity = useRef(tab.activity)
  useEffect(() => {
    if (tab.activity === 'working' && seenActivity.current !== 'working') setWorkingSince(Date.now())
    if (tab.activity !== 'working') setWorkingSince(null)
    seenActivity.current = tab.activity
  }, [tab.activity])
  const cursor = useRef({ start: 0, end: 0 })
  const list = useRef<HTMLDivElement>(null)
  // Ajuste de rolagem para depois de desenhar: ao fim (mensagem nova) ou mantendo o lugar (página anterior no topo).
  const anchor = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number; top: number } | null>(null)
  const generation = useRef(0)
  const following = useRef<Promise<void> | null>(null)
  const again = useRef(false)
  const loaded = useRef(false)
  const retries = useRef(0)
  const followRef = useRef<() => void>(() => {})

  const nearBottom = (): boolean => {
    const element = list.current
    return !element || element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
  }

  const fetchPage = (query: string): Promise<TranscriptPage> => api<TranscriptPage>(`transcript?tab=${encodeURIComponent(tab.id)}&${query}`)

  const loadLatest = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    loaded.current = false
    try {
      const page = await fetchPage(`limit=${PAGE}`)
      if (mine !== generation.current) return
      cursor.current = { start: page.start, end: page.end }
      loaded.current = true
      setStatus(page.status ?? {})
      anchor.current = { kind: 'bottom' }
      setItems(page.items)
      setOlder(page.atStart ? 'done' : 'idle')
      setUnseen(false)
    } catch (error) {
      if (mine === generation.current) onError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mine === generation.current) setLoading(false)
    }
  }, [tab.id, onError])

  // Um pedido de novidades por vez; aviso que chega no meio vira mais uma volta no fim, não um pedido paralelo
  // (dois "after" do mesmo cursor trariam as mesmas mensagens duas vezes).
  const follow = useCallback((): void => {
    // Sem a primeira página o cursor ainda é 0: pedir as novidades dali traria o começo da conversa como se fosse o fim.
    if (!loaded.current) return void loadLatest()
    if (following.current) {
      again.current = true
      return
    }
    const mine = generation.current
    following.current = (async () => {
      // Uma leitura traz no máximo um pedaço (o PC limita bytes e linhas por pedido): enquanto o cursor anda, pede de
      // novo, senão o resto de um atraso grande só viria com a próxima escrita do agente.
      let advanced: boolean
      do {
        again.current = false
        const page = await fetchPage(`after=${cursor.current.end}`)
        if (mine !== generation.current) return
        if (page.reset) return void loadLatest()
        // O status pode mudar sem o cursor andar, e chega só com os campos que o agente gravou neste trecho.
        if (page.status) setStatus((current) => ({ ...current, ...page.status }))
        advanced = page.end !== cursor.current.end
        if (!advanced) continue
        cursor.current.end = page.end
        if (page.items.length === 0) continue
        const stick = nearBottom()
        if (stick) anchor.current = { kind: 'bottom' }
        else setUnseen(true)
        setItems((current) => [...current, ...page.items])
      } while (again.current || advanced)
      retries.current = 0
    })().catch(() => {
      // Falha passageira (rede, PC ocupado): tenta de novo sozinho, porque com o agente parado não haveria outro aviso.
      if (mine !== generation.current || retries.current >= FOLLOW_RETRIES) return
      retries.current++
      setTimeout(() => { if (mine === generation.current) followRef.current() }, FOLLOW_RETRY_MS * retries.current)
    }).finally(() => { following.current = null })
  }, [tab.id, loadLatest])
  followRef.current = follow

  const loadOlder = async (): Promise<void> => {
    if (older !== 'idle') return
    setOlder('loading')
    const mine = generation.current
    try {
      const page = await fetchPage(`before=${cursor.current.start}&limit=${PAGE}`)
      if (mine !== generation.current) return
      if (page.reset) return void loadLatest()
      const element = list.current
      if (element) anchor.current = { kind: 'keep', height: element.scrollHeight, top: element.scrollTop }
      cursor.current.start = page.start
      setItems((current) => [...page.items, ...current])
      setOlder(page.atStart ? 'done' : 'idle')
    } catch (error) {
      if (mine === generation.current) {
        setOlder('idle')
        onError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  useEffect(() => {
    if (!connected) return
    setLoading(true)
    void loadLatest()
  }, [sessionId, connected, connection, loadLatest])

  useEffect(() => {
    const receive = (event: TranscriptEvent): void => { if (event.sessionId === sessionId && !loading) follow() }
    feed.current.transcript = receive
    return () => { if (feed.current.transcript === receive) feed.current.transcript = null }
  }, [sessionId, loading, follow, feed])

  // Rede de segurança: virar de "trabalhando" para "esperando" quase sempre coincide com o fim do turno gravado.
  useEffect(() => { if (!loading && connected) follow() }, [tab.activity, loading, connected, follow])

  // O aviso de arquivo alterado não chega sempre: no Windows, arquivo que o agente mantém aberto (o -wal do SQLite do
  // OpenCode) não avisa a pasta a cada escrita. Com o agente trabalhando, o celular confere as novidades sozinho.
  useEffect(() => {
    if (loading || !connected || tab.activity !== 'working') return
    const timer = setInterval(follow, WORKING_POLL_MS)
    return () => clearInterval(timer)
  }, [tab.activity, loading, connected, follow])

  useLayoutEffect(() => {
    const element = list.current
    const want = anchor.current
    if (!element || !want) return
    anchor.current = null
    if (want.kind === 'bottom') element.scrollTop = element.scrollHeight
    else element.scrollTop = want.top + element.scrollHeight - want.height
  }, [items])

  const results = useMemo(() => {
    const map = new Map<string, Result>()
    for (const item of items) if (item.kind === 'result') map.set(item.toolId, item)
    return map
  }, [items])
  const waitingOn = tab.activity === 'working' ? null : pendingTool(items, results)
  const turnStart = openTurnStart(items) ?? workingSince ?? NaN

  const click = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement
    const copy = target.closest('.code-copy')
    if (copy) {
      const pre = copy.parentElement
      const code = pre?.querySelector('code')?.textContent ?? ''
      void copyWithNotice(code, 'Código copiado.').catch((error: Error) => onError(error.message))
      return
    }
    const link = target.closest('a')
    const href = link?.getAttribute('href') ?? ''
    if (link) {
      event.preventDefault()
      if (/^https?:\/\//i.test(href)) openUrl(href)
    }
  }

  return <div className="reading-area">
    {tab.agent && <ReadingStatus kind={tab.agent.kind} status={status} connected={connected} open={modelSheet} onOpen={onModelSheet} onSend={onSend} />}
    <div className="reading-list" ref={list} onClick={click} onScroll={(event) => {
      const element = event.currentTarget
      if (element.scrollTop < 200) void loadOlder()
      if (unseen && nearBottom()) setUnseen(false)
    }}>
      {loading ? <SkeletonRows label="Abrindo a conversa" row="reading-skeleton" count={4} detail /> : <>
        {older === 'done' ? <p className="reading-edge">Início da conversa</p>
          : <button type="button" className="reading-older" disabled={older === 'loading'} onClick={() => void loadOlder()}>{older === 'loading' ? 'Carregando…' : 'Mensagens anteriores'}</button>}
        {items.length === 0 && older === 'done' && <p className="empty-copy">Nada na conversa ainda. A mensagem que você mandar aparece aqui quando o agente gravar.</p>}
        {items.map((item) => {
          if (item.kind === 'result') return null
          if (item.kind === 'user') return <div key={item.id} className="reading-user">
            <p>{item.text}</p>
            {item.images > 0 && <small><Icon name="imagem" />{item.images === 1 ? '1 imagem' : `${item.images} imagens`}</small>}
          </div>
          if (item.kind === 'assistant') return <Assistant key={item.id} text={item.text} truncated={item.truncated} />
          if (item.kind === 'tool') return <ToolRow key={item.id} tool={item} result={results.get(item.toolId)} />
          if (item.kind === 'turn') return <p key={item.id} className="reading-turn"><Icon name="ok" />{item.durationMs !== null ? `Trabalhou por ${duration(item.durationMs)}` : 'Turno concluído'}</p>
          return <p key={item.id} className="reading-note">{item.text}</p>
        })}
        {tab.activity === 'working' && <div className="reading-working" role="status"><span className="activity-dot working" />Trabalhando{Number.isFinite(turnStart) && <Elapsed since={turnStart} />}<button type="button" onClick={onInterrupt} disabled={!connected}>Interromper</button></div>}
        {waitingOn && <button type="button" className="reading-waiting" onClick={onTerminal}><Icon name="alerta" active /><span><strong>O agente pode estar esperando você no terminal</strong><small>{waitingOn.name}{waitingOn.summary ? ` · ${waitingOn.summary}` : ''}. Toque para abrir o terminal.</small></span></button>}
      </>}
    </div>
    {unseen && <button type="button" className="reading-unseen" onClick={() => { const element = list.current; if (element) element.scrollTop = element.scrollHeight; setUnseen(false) }}><Icon name="setaBaixo" />Novas mensagens</button>}
  </div>
}
