import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { viewerFor } from '@shared/file-kind'
import { Icon } from '@/brand/icons'
import { api, offline } from './api'
import { CodeEditor } from './CodeEditor'
import { PdfPages } from './PdfPages'
import { SkeletonCode } from './Skeleton'
import { canDownload, download, onDownloaded, openDownloaded } from './downloads'

type Kind = 'markdown' | 'html' | 'code' | 'pdf' | 'image' | 'external'
const kindOf = (path: string): Kind => (/\.html?$/i.test(path) ? 'html' : viewerFor(path))
interface TextFile { content: string; mtimeMs: number; raw: string }
// downloaded: o app acabou de salvar o arquivo no celular, e o aviso oferece abrir.
type Notice = { tone: 'error' | 'conflict' | 'info'; text: string; downloaded?: boolean }

// O voltar do celular não pergunta nada: o texto editado e não salvo fica aqui e volta quando o arquivo é reaberto.
// mtimeMs é a versão do arquivo em que o rascunho foi feito: se o agente mexeu depois, salvar dá conflito.
const drafts = new Map<string, { text: string; mtimeMs: number }>()
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Imagem e link relativos do Markdown apontam para o mesmo link de leitura do arquivo, como no PC.
function markdownHtml(source: string, raw: string): string {
  const html = DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }))
  const base = new URL(raw.slice(0, raw.lastIndexOf('/') + 1), location.origin)
  const link = raw.split('/').slice(0, 3).join('/') + '/'
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const element of doc.querySelectorAll<HTMLElement>('img[src], a[href]')) {
    const attribute = element.tagName === 'IMG' ? 'src' : 'href'
    const value = element.getAttribute(attribute) ?? ''
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(value)) continue
    const target = new URL(value, base).pathname
    // Caminho que sobe para fora do link (../../x.png) não tem como abrir: fica sem destino, sem um erro enganoso.
    if (target.startsWith(link)) element.setAttribute(attribute, target)
    else element.removeAttribute(attribute)
  }
  return doc.body.innerHTML
}

// connection: muda a cada vez que a ligação com o PC volta (MobileApp); o arquivo que não abriu tenta de novo sozinho.
export function FileViewer({ projectId, path, dark, connection, onBack, onChat, onOpenFile }: { projectId: string; path: string; dark: boolean; connection: number; onBack(): void; onChat?(): void; onOpenFile(path: string): void }): React.JSX.Element {
  const kind = kindOf(path)
  const textual = kind === 'markdown' || kind === 'html' || kind === 'code'
  const key = `${projectId}:${path}`
  const query = `project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
  const name = path.split(/[\\/]/).pop() ?? path
  const folder = path.slice(0, path.length - name.length).replace(/[\\/]$/, '')
  // O link de leitura do PC não entrega arquivo oculto (.env), nem para baixar; numa pasta oculta (.kora/temp), entrega.
  const hidden = name.startsWith('.')
  const [file, setFile] = useState<TextFile | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  // Muda a cada leitura do PC: o editor remonta com o texto novo. Entre Ver e Editar ele remonta com o texto atual.
  const [version, setVersion] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'edit'>(kind === 'code' ? 'edit' : 'view')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  // Versão do arquivo sobre a qual o texto está sendo editado: é ela que o salvar manda para o PC conferir.
  const [base, setBase] = useState(0)
  // Toque no PDF esconde a barra de página e zoom, a faixa do arquivo e o cabeçalho do Kora (os dois pelo CSS).
  const [immersive, setImmersive] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const baseRef = useRef(base)
  baseRef.current = base
  // Só depois de abrir: se a reabertura falhou (rede, PC fora), o rascunho guardado não pode ser apagado ao sair.
  const opened = useRef(false)
  const failed = useRef(false)
  const connectionRef = useRef(connection)
  connectionRef.current = connection

  const load = useCallback(async (restore: boolean): Promise<void> => {
    setLoading(true)
    const since = connectionRef.current
    let retry = false
    try {
      if (!textual) {
        setRaw((await api<{ raw: string }>(`file-link?${query}`)).raw)
        failed.current = false
        return setNotice(null)
      }
      const loaded = await api<TextFile>(`file?${query}`)
      failed.current = false
      const saved = restore ? drafts.get(key) : undefined
      opened.current = true
      setFile(loaded)
      setRaw(loaded.raw)
      setBase(saved?.mtimeMs ?? loaded.mtimeMs)
      setDraft(saved?.text ?? null)
      setVersion((previous) => previous + 1)
      setNotice(saved === undefined ? null
        : saved.mtimeMs !== loaded.mtimeMs ? { tone: 'conflict', text: 'Suas alterações não salvas voltaram, mas o arquivo mudou no PC depois delas, talvez pelo agente.' }
        : { tone: 'info', text: 'Alterações que você não salvou voltaram.' })
    } catch (error) {
      failed.current = true
      setNotice({ tone: 'error', text: message(error) })
      // A ligação com o PC voltou enquanto este pedido ainda falhava (pelo relay ele leva até 15 s): tenta de novo já.
      retry = connectionRef.current !== since
    } finally {
      setLoading(false)
      if (retry) void load(restore)
    }
  }, [textual, query, key])
  useEffect(() => { void load(true) }, [load])
  useEffect(() => { if (failed.current) void load(true) }, [connection, load])
  useEffect(() => onDownloaded((event) => {
    setDownloading(false)
    setNotice(event.tipo === 'salvo' ? { tone: 'info', text: `Salvo em Downloads/Kora como ${event.nome}.`, downloaded: true } : { tone: 'error', text: event.mensagem })
  }), [])
  const fetchDownload = async (): Promise<void> => {
    setDownloading(true)
    setNotice(null)
    try {
      // No navegador o download segue sozinho; no app, a resposta chega por onDownloaded.
      if (await download(query, name) === 'browser') setDownloading(false)
    } catch (error) {
      setDownloading(false)
      setNotice({ tone: 'error', text: message(error) })
    }
  }
  useEffect(() => () => {
    if (!opened.current) return
    if (draftRef.current === null) drafts.delete(key)
    else drafts.set(key, { text: draftRef.current, mtimeMs: baseRef.current })
  }, [key])

  const save = async (mtimeMs: number): Promise<void> => {
    if (draft === null || !file) return
    const sent = draft
    setSaving(true)
    setNotice(null)
    try {
      const response = await fetch('/api/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, path, content: sent, mtimeMs }) }).catch(offline)
      const result = await response.json().catch(() => ({}))
      if (response.status === 409) return setNotice({ tone: 'conflict', text: 'O arquivo mudou no PC depois que você abriu, talvez pelo agente.' })
      if (!response.ok) throw new Error(result.error ?? 'Não deu para salvar no PC.')
      setFile({ ...file, content: sent, mtimeMs: result.mtimeMs })
      setBase(result.mtimeMs)
      // O que foi digitado enquanto o PC respondia continua sem salvar.
      setDraft((current) => (current === sent ? null : current))
      setNotice({ tone: 'info', text: 'Salvo no PC.' })
      // O link de leitura (prévia do HTML, imagens do Markdown) vale 30 min: renova para a prévia mostrar o salvo.
      void api<{ raw: string }>(`file-link?${query}`).then((link) => setRaw(link.raw), () => {})
    } catch (error) {
      setNotice({ tone: 'error', text: message(error) })
    } finally {
      setSaving(false)
    }
  }
  const overwrite = async (): Promise<void> => {
    try {
      await save((await api<TextFile>(`file?${query}`)).mtimeMs)
    } catch (error) {
      setNotice({ tone: 'error', text: message(error) })
    }
  }
  const discard = (): void => {
    drafts.delete(key)
    void load(false)
  }

  const shown = draft ?? file?.content ?? ''
  const rendered = useMemo(() => (kind === 'markdown' && raw ? markdownHtml(shown, raw) : ''), [kind, shown, raw])
  const switchable = kind === 'markdown' || kind === 'html'

  return <main className={`file-page page-enter ${immersive ? 'immersive' : ''}`}>
    <div className="file-header">
      <button className="icon-button back-button" aria-label="Voltar" onClick={onBack}><Icon name="expandir" className="back-icon" /></button>
      <span className="file-title"><strong>{name}</strong>{folder && <small>{folder}</small>}</span>
      {switchable && <div className="file-mode" role="group" aria-label="Modo do arquivo">
        <button aria-pressed={mode === 'view'} onClick={() => setMode('view')}><Icon name="visualizar" />Ver</button>
        <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}><Icon name="editar" />Editar</button>
      </div>}
      {!textual && raw && <button className="icon-button" aria-label="Recarregar do PC" onClick={() => void load(false)}><Icon name="atualizar" /></button>}
      {canDownload() && !hidden && <button className="icon-button" aria-label="Baixar para o celular" aria-busy={downloading} disabled={downloading} onClick={() => void fetchDownload()}><Icon name="baixar" /></button>}
      {textual && draft !== null && <button className="primary save-button" disabled={saving} onClick={() => void save(base)}>{saving ? 'Salvando…' : 'Salvar'}</button>}
      {onChat && <button className="icon-button chat-return" aria-label="Voltar à conversa" onClick={onChat}><Icon name="conversa" active /></button>}
    </div>
    {notice && <div role={notice.tone === 'info' ? 'status' : 'alert'} className={`file-notice ${notice.tone}`}>
      <span>{notice.text}</span>
      {notice.tone === 'conflict' && <span className="file-notice-actions">
        <button onClick={discard}>Recarregar do PC</button>
        <button onClick={() => void overwrite()}>Salvar por cima</button>
      </span>}
      {notice.downloaded && <span className="file-notice-actions"><button onClick={openDownloaded}>Abrir</button></span>}
      {notice.tone === 'error' && failed.current && <span className="file-notice-actions"><button onClick={() => void load(true)}>Tentar de novo</button></span>}
      {notice.tone !== 'conflict' && <button className="icon-button" aria-label="Dispensar aviso" onClick={() => setNotice(null)}><Icon name="fechar" /></button>}
    </div>}
    <div className="file-body">
      {!file && !raw && loading && <SkeletonCode label="Abrindo o arquivo…" />}
      {!file && !raw && !loading && <div className="file-retry"><button onClick={() => void load(true)}><Icon name="atualizar" />Tentar de novo</button></div>}
      {textual && file && (mode === 'edit' || kind === 'code')
        && <CodeEditor key={version} path={path} text={shown} dark={dark} onChange={(text) => setDraft(text === file.content ? null : text)} />}
      {kind === 'markdown' && file && mode === 'view' && <article className="markdown-view" onClick={(event) => {
        const link = (event.target as HTMLElement).closest('a')
        if (!link) return
        event.preventDefault()
        const href = link.getAttribute('href') ?? ''
        // Link para outro arquivo do projeto abre aqui mesmo; link da internet vai para o navegador.
        const prefix = raw ? raw.split('/').slice(0, 3).join('/') + '/' : null
        if (prefix && href.startsWith(prefix)) onOpenFile(href.slice(prefix.length).split('/').map(decodeURIComponent).join('/'))
        else if (/^https?:\/\//.test(href)) window.open(link.href)
      }} dangerouslySetInnerHTML={{ __html: rendered }} />}
      {kind === 'html' && raw && mode === 'view' && <>
        <div className="file-hint">
          <span>{draft !== null ? 'Mostrando a versão salva. Salve para ver as alterações aqui.' : 'Prévia na largura do celular.'}</span>
          {/* No navegador do celular a página carrega inteira, com zoom; o app Android leva este link para lá. */}
          <a className="open-full" href={new URL(raw, location.origin).href} target="_blank" rel="noopener"><Icon name="externo" />Abrir página inteira</a>
        </div>
        <iframe title={name} className="html-view" sandbox="allow-scripts allow-popups" src={`${raw}?v=${file?.mtimeMs ?? 0}`} />
      </>}
      {kind === 'image' && raw && <div className="image-view"><img src={raw} alt={name} onError={() => {
        failed.current = true
        setNotice({ tone: 'error', text: 'Não deu para trazer a imagem do PC. Ela abre de novo quando a conexão voltar.' })
      }} /></div>}
      {kind === 'pdf' && raw && <PdfPages url={raw} controls={!immersive} onTap={() => setImmersive((on) => !on)} onError={() => { failed.current = true }} />}
      {kind === 'external' && <p className="empty-copy">{canDownload() ? 'Este tipo de arquivo não abre no Kora. Baixe para abrir com outro app do celular.' : 'Este tipo de arquivo não abre no celular. Abra pelo PC.'}</p>}
    </div>
  </main>
}
