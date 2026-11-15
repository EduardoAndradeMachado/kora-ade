import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { viewerFor } from '@shared/file-kind'
import type { MobileFileStat } from '@shared/mobile'
import { Icon } from '@/brand/icons'
import { findAnchor, isSameDocument, resolveMarkdownHref } from '@/lib/markdown-links'
import { renderMermaidBlocks } from '@/lib/mermaid-blocks'
import { detectDelimiter, parseCsv } from '@/lib/csv'
import { csvRecordAtLine } from '@/lib/sheet-jump'
import { openXlsx, XlsxError, type XlsxBook } from '@/lib/xlsx'
import { api, koraApp, offline } from './api'
import { CodeEditor, type CodeEditorHandle } from './CodeEditor'
import { PdfPages } from './PdfPages'
import { SkeletonCode } from './Skeleton'
import { canDownload, download, onDownloaded, openDownloaded, preferredDownload, progressText } from './downloads'
import { FileActions, type EntryChange } from './FileActions'
import { copyText } from './CopyActions'
import { onFilesChanged } from './file-events'
import { eventTouches, followAction } from './file-follow'
import { blockAtLine, markdownHtml } from './markdown-html'
import { SheetPage } from './SheetPage'
import { DiffPanel, ExternalCard, ImagePage, NotebookPage } from './ViewerParts'
import { hasEditMode, isTextual, mobileViewerFor, sheetOpenDecision, startsInEdit, tapsToImmerse } from './viewer-kind'

export { hasEditMode }

interface TextFile { content: string; mtimeMs: number; raw: string }
// downloaded: o app acabou de salvar o arquivo no celular, e o aviso oferece abrir. fades: some sozinho (o que só
// informa, como "Atualizado com a versão do PC"). gone: o arquivo sumiu do PC, com o Copiar do que foi editado.
type Notice = { tone: 'error' | 'conflict' | 'info'; text: string; downloaded?: boolean; fades?: boolean; gone?: boolean }
type Book = { status: 'loading' } | { status: 'ready'; book: XlsxBook } | { status: 'ask' | 'too-large'; size: number } | { status: 'error'; message: string }

// O voltar do celular não pergunta nada: o texto editado e não salvo fica aqui e volta quando o arquivo é reaberto.
// mtimeMs é a versão do arquivo em que o rascunho foi feito: se o agente mexeu depois, salvar dá conflito.
const drafts = new Map<string, { text: string; mtimeMs: number }>()
// Arquivo (ou pasta dele) renomeado, movido ou apagado pelo celular: o rascunho vai junto para o caminho novo, ou sai.
// moved cobre o arquivo aberto agora (showing), cujo rascunho só é guardado quando ele fecha.
const moved = new Map<string, string | null>()
const showing = new Set<string>()
export function followEntry(projectId: string, from: string, to: string | null): void {
  const norm = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
  const prefix = `${projectId}:`
  const follow = (key: string): string | null | undefined => {
    const path = key.slice(prefix.length)
    if (!key.startsWith(prefix) || (norm(path) !== norm(from) && !norm(path).startsWith(`${norm(from)}/`))) return undefined
    return to === null ? null : prefix + to + path.slice(from.length)
  }
  // Cópia da lista: a volta grava chaves novas no mesmo Map.
  for (const [key, draft] of Array.from(drafts)) {
    const next = follow(key)
    if (next === undefined) continue
    drafts.delete(key)
    if (next !== null) drafts.set(next, draft)
  }
  if (showing.has(prefix + from)) moved.set(prefix + from, to === null ? null : prefix + to)
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Link `outro.md#secao`: o visualizador do destino é outro (a rota muda) e rola até a seção quando o texto chegar.
let pendingAnchor: { key: string; anchor: string } | null = null

// Celular deitado: o mesmo corte do mobile.css, onde o cabeçalho do Kora sai.
const LANDSCAPE = '(orientation: landscape) and (max-height: 500px)'
const landscapeNow = (): boolean => typeof matchMedia === 'function' && matchMedia(LANDSCAPE).matches
const FADE_MS = 4000
const JUMP_MS = 4000

// connection: muda a cada vez que a ligação com o PC volta (MobileApp); o arquivo que não abriu tenta de novo sozinho.
// line: a linha pedida pelo `arquivo:42` tocado no terminal.
export function FileViewer({ projectId, path, dark, connection, line = null, onBack, onChat, onOpenFile, actions, onActions, onEntryChanged, startInEdit = false }: { projectId: string; path: string; dark: boolean; connection: number; line?: number | null; onBack(): void; onChat?(): void; onOpenFile(path: string): void; actions: boolean; onActions(open: boolean): void; onEntryChanged(change: EntryChange): void; startInEdit?: boolean }): React.JSX.Element {
  const viewer = mobileViewerFor(path)
  const textual = isTextual(viewer)
  const key = `${projectId}:${path}`
  const query = `project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
  const name = path.split(/[\\/]/).pop() ?? path
  const folder = path.slice(0, path.length - name.length).replace(/[\\/]$/, '')
  // O link de leitura do PC não entrega arquivo oculto (.env), nem para baixar; numa pasta oculta (.kora/temp), entrega.
  const hidden = name.startsWith('.')
  const [file, setFile] = useState<TextFile | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [stat, setStat] = useState<MobileFileStat | null>(null)
  // Muda a cada leitura do PC: o editor troca o texto no lugar, sem perder a rolagem.
  const [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)
  // Tudo abre em Ver: o código só leitura não abre o teclado, e o toque longo seleciona com as alças do Android.
  const [mode, setMode] = useState<'view' | 'edit'>(startInEdit || startsInEdit(viewer, line) ? 'edit' : 'view')
  const [notice, setNotice] = useState<Notice | null>(null)
  // As duas saídas do conflito que jogam trabalho fora pedem confirmação antes.
  const [confirm, setConfirm] = useState<'reload' | 'overwrite' | null>(null)
  const [compare, setCompare] = useState<{ pc: string | null; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  // Versão do arquivo sobre a qual o texto está sendo editado: é ela que o salvar manda para o PC conferir.
  const [base, setBase] = useState(0)
  // Toque no PDF ou na imagem esconde a barra de página e zoom, a faixa do arquivo e o cabeçalho do Kora (pelo CSS).
  // Deitado, eles já abrem assim: virar o celular é para ver mais da página.
  const immersible = tapsToImmerse(viewer)
  const [landscape, setLandscape] = useState(landscapeNow)
  const [immersive, setImmersive] = useState(() => immersible && landscapeNow())
  const [downloading, setDownloading] = useState(false)
  // Salvar como abre o seletor de pastas do Android antes de baixar: até o primeiro progresso, o aviso diz isso.
  const [choosing, setChoosing] = useState(false)
  const [progress, setProgress] = useState<{ recebidos: number; total: number } | null>(null)
  const [selecting, setSelecting] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const baseRef = useRef(base)
  baseRef.current = base
  // Só depois de abrir: se a reabertura falhou (rede, PC fora), o rascunho guardado não pode ser apagado ao sair.
  const opened = useRef(false)
  const failed = useRef(false)
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  // A versão (mtime) que a tela mostra; null quando o arquivo sumiu do PC. É contra ela que o aviso do PC é conferido.
  const known = useRef<number | null>(null)
  // Lendo ou salvando, o aviso do PC fica para depois: a própria gravação do celular também gera aviso.
  const busy = useRef(false)
  const pending = useRef(false)
  const checkRef = useRef<() => Promise<void>>(async () => {})
  const editor = useRef<CodeEditorHandle | null>(null)

  const load = useCallback(async (restore: boolean, quiet = false): Promise<boolean> => {
    setLoading(true)
    busy.current = true
    const since = connectionRef.current
    let retry = false
    // Também liga o observador de pastas do PC para este projeto: o arquivo pode ter vindo de um link do terminal.
    const current = api<MobileFileStat>(`file-stat?${query}`)
    current.catch(() => {})
    try {
      if (!textual) {
        const [link, stat] = await Promise.all([api<{ raw: string }>(`file-link?${query}`), current])
        failed.current = false
        setRaw(link.raw)
        setStat(stat)
        known.current = stat.exists ? stat.mtimeMs : null
        if (!quiet) setNotice(null)
        return true
      }
      const loaded = await api<TextFile>(`file?${query}`)
      void current.then(setStat, () => {})
      failed.current = false
      // Recarga automática: o editor segue editável durante o GET, e o que foi digitado nesse meio não é trocado
      // pela versão do PC; vira conflito, como se o aviso tivesse chegado com o rascunho já feito.
      if (quiet && !restore && draftRef.current !== null) {
        known.current = loaded.mtimeMs
        setNotice({ tone: 'conflict', text: 'O arquivo mudou no PC enquanto você editava, talvez pelo agente.' })
        return false
      }
      const saved = restore ? drafts.get(key) : undefined
      opened.current = true
      known.current = loaded.mtimeMs
      setFile(loaded)
      setRaw(loaded.raw)
      setBase(saved?.mtimeMs ?? loaded.mtimeMs)
      setDraft(saved?.text ?? null)
      setRevision((previous) => previous + 1)
      if (!quiet) setNotice(saved === undefined ? null
        : saved.mtimeMs !== loaded.mtimeMs ? { tone: 'conflict', text: 'Suas alterações não salvas voltaram, mas o arquivo mudou no PC depois delas, talvez pelo agente.' }
        : { tone: 'info', text: 'Alterações que você não salvou voltaram.' })
      return true
    } catch (error) {
      failed.current = true
      setNotice({ tone: 'error', text: message(error) })
      // Texto que o PC não entrega (grande demais, binário): o cartão com o tamanho e o Baixar fica no lugar.
      if (textual) setStat(await current.catch(() => null))
      // A ligação com o PC voltou enquanto este pedido ainda falhava (pelo relay ele leva até 15 s): tenta de novo já.
      retry = connectionRef.current !== since
      return false
    } finally {
      setLoading(false)
      busy.current = false
      if (retry) void load(restore)
      else if (pending.current) {
        pending.current = false
        void checkRef.current()
      }
    }
  }, [textual, query, key])

  // O arquivo aberto mudou no PC (o agente gravou, apagou ou renomeou). Sem nada por salvar, a versão nova vem
  // sozinha; com rascunho, o aviso vem na hora, e não só quando ele tentar salvar.
  const check = useCallback(async (): Promise<void> => {
    if (busy.current) return void (pending.current = true)
    let current: MobileFileStat
    try {
      current = await api<MobileFileStat>(`file-stat?${query}`)
    } catch {
      return
    }
    if (busy.current) return void (pending.current = true)
    const action = followAction(known.current, current, draftRef.current !== null)
    if (action === 'same') return
    setStat(current)
    setConfirm(null)
    if (action === 'gone') {
      known.current = null
      return setNotice({ tone: 'error', gone: true, text: draftRef.current !== null ? 'Este arquivo foi apagado ou renomeado no PC. O que você editou continua aqui: copie antes de sair.' : 'Este arquivo foi apagado ou renomeado no PC.' })
    }
    if (action === 'conflict') {
      known.current = current.exists ? current.mtimeMs : null
      return setNotice({ tone: 'conflict', text: 'O arquivo mudou no PC enquanto você editava, talvez pelo agente.' })
    }
    if (await load(false, true)) setNotice({ tone: 'info', text: 'Atualizado com a versão do PC.', fades: true })
  }, [query, load])
  checkRef.current = check

  useEffect(() => { void load(true) }, [load])
  const seenConnection = useRef(connection)
  useEffect(() => {
    if (seenConnection.current === connection) return
    seenConnection.current = connection
    // A ligação voltou: o que não abriu tenta de novo, e o que estava aberto confere o que perdeu de aviso.
    if (failed.current) void load(true)
    else void checkRef.current()
  }, [connection, load])
  useEffect(() => onFilesChanged((event) => { if (eventTouches(event, projectId, path)) void checkRef.current() }), [projectId, path])
  useEffect(() => {
    const visible = (): void => { if (!document.hidden) void checkRef.current() }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [])
  useEffect(() => {
    if (!notice?.fades) return
    const timer = setTimeout(() => setNotice((current) => (current === notice ? null : current)), FADE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const media = typeof matchMedia === 'function' ? matchMedia(LANDSCAPE) : null
    if (!media) return
    const turned = (): void => {
      setLandscape(media.matches)
      if (immersible) setImmersive(media.matches)
    }
    media.addEventListener('change', turned)
    return () => media.removeEventListener('change', turned)
  }, [immersible])
  // O app Android esconde as barras do sistema junto (a partir da versão que tiver telaCheia).
  useEffect(() => {
    const app = koraApp()
    app?.telaCheia?.(immersive)
    return () => { if (immersive) app?.telaCheia?.(false) }
  }, [immersive])

  useEffect(() => onDownloaded((event) => {
    if (event.tipo === 'progresso') return setProgress(event)
    setProgress(null)
    setDownloading(false)
    if (event.tipo === 'cancelado' || event.tipo === 'compartilhado') return
    setNotice(event.tipo === 'salvo' ? { tone: 'info', text: event.destino === 'escolhido' ? `Salvo no local escolhido como ${event.nome}.` : `Salvo em Downloads/Kora como ${event.nome}.`, downloaded: true } : { tone: 'error', text: event.mensagem })
  }), [])
  const fetchDownload = async (action: 'baixar' | 'salvarComo' | 'compartilhar' = preferredDownload()): Promise<void> => {
    if (actions) onActions(false)
    setProgress(null)
    setChoosing(action === 'salvarComo')
    setDownloading(true)
    setNotice(null)
    try {
      // No navegador o download segue sozinho; no app, a resposta chega por onDownloaded.
      if (await download(query, name, action) === 'browser') setDownloading(false)
    } catch (error) {
      setDownloading(false)
      setNotice({ tone: 'error', text: message(error) })
    }
  }
  useEffect(() => {
    showing.add(key)
    return () => {
      showing.delete(key)
      const target = moved.has(key) ? moved.get(key)! : key
      moved.delete(key)
      if (!opened.current) return
      drafts.delete(key)
      if (target !== null && draftRef.current !== null) drafts.set(target, { text: draftRef.current, mtimeMs: baseRef.current })
    }
  }, [key])

  const save = async (mtimeMs: number): Promise<void> => {
    if (draft === null || !file) return
    const sent = draft
    setSaving(true)
    busy.current = true
    setNotice(null)
    try {
      const response = await fetch('/api/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, path, content: sent, mtimeMs }) }).catch(offline)
      const result = await response.json().catch(() => ({}))
      if (response.status === 409) return setNotice({ tone: 'conflict', text: 'O arquivo mudou no PC depois que você abriu, talvez pelo agente.' })
      if (!response.ok) throw new Error(result.error ?? 'Não deu para salvar no PC.')
      known.current = result.mtimeMs
      setFile({ ...file, content: sent, mtimeMs: result.mtimeMs })
      setBase(result.mtimeMs)
      setCompare(null)
      // O que foi digitado enquanto o PC respondia continua sem salvar.
      setDraft((current) => (current === sent ? null : current))
      setNotice({ tone: 'info', text: 'Salvo no PC.', fades: true })
      // O link de leitura (prévia do HTML, imagens do Markdown) vale 30 min: renova para a prévia mostrar o salvo.
      void api<{ raw: string }>(`file-link?${query}`).then((link) => setRaw(link.raw), () => {})
    } catch (error) {
      setNotice({ tone: 'error', text: message(error) })
    } finally {
      setSaving(false)
      busy.current = false
      if (pending.current) {
        pending.current = false
        void checkRef.current()
      }
    }
  }
  const overwrite = async (): Promise<void> => {
    try {
      const current = await api<MobileFileStat>(`file-stat?${query}`)
      if (!current.exists) return setNotice({ tone: 'error', gone: true, text: 'Este arquivo foi apagado ou renomeado no PC. O que você editou continua aqui: copie antes de sair.' })
      await save(current.mtimeMs)
    } catch (error) {
      setNotice({ tone: 'error', text: message(error) })
    }
  }
  const discard = (): void => {
    drafts.delete(key)
    setCompare(null)
    void load(false)
  }
  const openCompare = async (): Promise<void> => {
    setCompare({ pc: null })
    try {
      setCompare({ pc: (await api<TextFile>(`file?${query}`)).content })
    } catch (error) {
      setCompare({ pc: null, error: message(error) })
    }
  }

  const shown = draft ?? file?.content ?? ''
  // Só em Ver: no Editar, o Markdown que derruba o marked (FileBoundary) continua editável.
  const rendered = useMemo(() => (viewer === 'markdown' && raw && mode === 'view' ? markdownHtml(shown, raw, path) : ''), [viewer, shown, raw, path, mode])
  const articleRef = useRef<HTMLElement>(null)
  const diagrams = useRef({ dark, byIndex: new Map<number, string>() })
  // Um link por imagem de fora da pasta, enquanto o link do próprio arquivo valer (ele muda ao salvar).
  const imageLinks = useRef({ raw, byRel: new Map<string, Promise<string | null>>() })
  const markdownLine = useRef<number | null>(null)

  const scrollToAnchor = (anchor: string): void => {
    const found = articleRef.current && findAnchor(articleRef.current, anchor)
    if (found) found.scrollIntoView({ block: 'start' })
    else setNotice({ tone: 'error', text: `Seção não encontrada: #${anchor}` })
  }

  const openMarkdownLink = (href: string): void => {
    const target = resolveMarkdownHref(href, path)
    if (target.kind === 'external') window.open(target.url)
    else if (target.kind === 'blocked') setNotice({ tone: 'error', text: target.message })
    else if (target.kind === 'anchor') scrollToAnchor(target.anchor)
    else if (target.kind === 'file') {
      if (target.anchor !== null && isSameDocument(target.rel, path)) return scrollToAnchor(target.anchor)
      if (target.rel === '') return
      const next = target.rel.replace(/\\/g, '/')
      pendingAnchor = target.anchor !== null && viewerFor(next) === 'markdown' ? { key: `${projectId}:${next}`, anchor: target.anchor } : null
      onOpenFile(next)
    }
  }

  // Layout effect: o diagrama que já está no cache entra antes da pintura, como no PC.
  useLayoutEffect(() => {
    const article = articleRef.current
    if (!article || !rendered || mode !== 'view') return
    let current = true
    if (diagrams.current.dark !== dark) diagrams.current = { dark, byIndex: new Map() }
    void renderMermaidBlocks(article, dark, diagrams.current.byIndex, () => current)
    if (imageLinks.current.raw !== raw) imageLinks.current = { raw, byRel: new Map() }
    const links = imageLinks.current.byRel
    for (const img of article.querySelectorAll<HTMLImageElement>('img[data-rel]')) {
      const rel = (img.dataset['rel'] ?? '').replace(/\\/g, '/')
      let link = links.get(rel)
      if (!link) {
        link = api<{ raw: string }>(`file-link?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(rel)}`).then((r) => r.raw, () => null)
        links.set(rel, link)
      }
      void link.then((url) => {
        if (current && url) img.src = url
      })
    }
    if (pendingAnchor?.key === key) {
      const { anchor } = pendingAnchor
      pendingAnchor = null
      scrollToAnchor(anchor)
    } else if (line !== null && markdownLine.current !== line) {
      markdownLine.current = line
      const block = blockAtLine(article, line)
      if (block) {
        block.scrollIntoView({ block: 'start' })
        block.classList.add('md-jumped')
        setTimeout(() => block.classList.remove('md-jumped'), JUMP_MS)
      }
    }
    return () => {
      current = false
    }
    // scrollToAnchor só lê a ref e o setNotice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, dark, mode, raw, projectId, key, line])

  const delimiter = useMemo(() => (viewer !== 'csv' || !file ? ',' : /\.tsv$/i.test(path) ? '\t' : detectDelimiter(shown, ',')), [viewer, file, path, shown])
  const csvRows = useMemo(() => (viewer === 'csv' && file && mode === 'view' ? parseCsv(shown, delimiter) : null), [viewer, file, mode, shown, delimiter])
  const csvJump = useMemo(() => (csvRows && line !== null ? csvRecordAtLine(shown, delimiter, line) : null), [csvRows, line, shown, delimiter])

  // .xlsx: os bytes vêm pelo link de leitura, com os degraus de tamanho do PC (open-limits) antes de baixar.
  const [book, setBook] = useState<Book>({ status: 'loading' })
  const [bigAllowed, setBigAllowed] = useState(false)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [sheetRows, setSheetRows] = useState<{ rows: string[][] } | { error: string } | null>(null)
  const size = stat?.exists ? stat.size : null
  useEffect(() => {
    if (viewer !== 'xlsx' || !raw || size === null) return
    const decision = sheetOpenDecision(size, bigAllowed)
    if (decision !== 'open') return setBook({ status: decision, size })
    let cancelled = false
    const controller = new AbortController()
    setBook({ status: 'loading' })
    void (async () => {
      const response = await fetch(raw, { signal: controller.signal }).catch(offline)
      if (!response.ok) throw new Error('Não deu para trazer a planilha do PC. Ela abre de novo quando a conexão voltar.')
      const opened = await openXlsx(new Uint8Array(await response.arrayBuffer()))
      if (!cancelled) setBook({ status: 'ready', book: opened })
    })().catch((error: unknown) => {
      if (!cancelled) setBook({ status: 'error', message: error instanceof XlsxError ? error.message : message(error) })
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [viewer, raw, size, bigAllowed])
  const workbook = book.status === 'ready' ? book.book : null
  const sheet = workbook && sheetIndex < workbook.sheets.length ? sheetIndex : 0
  useEffect(() => {
    if (!workbook) return
    let cancelled = false
    setSheetRows(null)
    workbook.readSheet(sheet).then((rows) => !cancelled && setSheetRows({ rows }), (error: unknown) => !cancelled && setSheetRows({ error: error instanceof XlsxError ? error.message : message(error) }))
    return () => {
      cancelled = true
    }
  }, [workbook, sheet])

  const codeShown = textual && file !== null && (mode === 'edit' || viewer === 'code')
  useEffect(() => {
    if (!codeShown) return
    const changed = (): void => {
      const selection = document.getSelection()
      setSelecting(Boolean(selection && !selection.isCollapsed && document.querySelector('.code-editor')?.contains(selection.anchorNode)))
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [codeShown])
  // O toque no botão desfaz a seleção do WebView antes do clique: o trecho é guardado no começo do toque.
  const selectedAtTouch = useRef('')
  const copy = (): void => {
    const selected = selectedAtTouch.current
    const text = selected || editor.current?.all() || shown
    void copyText(text).then(() => setNotice({ tone: 'info', text: selected ? 'Seleção copiada.' : 'Arquivo inteiro copiado.', fades: true }), (error: Error) => setNotice({ tone: 'error', text: error.message }))
  }
  const immerse = immersible ? () => setImmersive((on) => !on) : () => {}
  const unavailable = canDownload() ? 'Este tipo de arquivo não abre no Kora. Baixe para abrir com outro app do celular.' : 'Este tipo de arquivo não abre no celular. Abra pelo PC.'
  const downloadAction = canDownload() && !hidden ? () => void fetchDownload() : undefined

  return <main className={`file-page page-enter ${immersive ? 'immersive' : ''}`}>
    <div className="file-header">
      <button className="icon-button back-button" aria-label="Voltar" onClick={onBack}><Icon name="expandir" className="back-icon" /></button>
      <span className="file-title"><strong>{name}</strong>{folder && <small>{folder}</small>}</span>
      <button className="icon-button" aria-label="Opções do arquivo" onClick={() => onActions(true)}>⋯</button>
      {textual && <div className="file-mode" role="group" aria-label="Modo do arquivo">
        <button aria-pressed={mode === 'view'} onClick={() => setMode('view')}><Icon name="visualizar" active={mode === 'view'} />Ver</button>
        <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}><Icon name="editar" active={mode === 'edit'} />Editar</button>
      </div>}
      {!textual && raw && <button className="icon-button" aria-label="Recarregar do PC" onClick={() => void load(false)}><Icon name="atualizar" /></button>}
      {canDownload() && !hidden && <button className="icon-button download-button" aria-label="Baixar para o celular" aria-busy={downloading} disabled={downloading} onClick={() => void fetchDownload()}>{downloading ? <span className="download-spinner" /> : <Icon name="baixar" />}</button>}
      {textual && draft !== null && <button className="primary save-button" disabled={saving} onClick={() => void save(base)}>{saving ? 'Salvando…' : 'Salvar'}</button>}
      {onChat && <button className="icon-button chat-return" aria-label="Voltar à conversa" onClick={onChat}><Icon name="conversa" active /></button>}
    </div>
    {actions && <FileActions projectId={projectId} name={name} path={path} busy={downloading} onClose={() => onActions(false)} onAction={(action) => void fetchDownload(action)} onChanged={onEntryChanged} />}
    {downloading && canDownload() && (() => {
      const shown = progress ? progressText(progress) : { text: choosing ? 'Escolha onde salvar no celular…' : 'Baixando do PC…', percent: null }
      return <div role="status" className="download-progress">
        <span>{shown.text}</span>
        <div className={`download-bar ${shown.percent === null ? 'indeterminate' : ''}`}><span style={shown.percent === null ? undefined : { width: `${shown.percent}%` }} /></div>
      </div>
    })()}
    {notice && <div role={notice.tone === 'info' ? 'status' : 'alert'} className={`file-notice ${notice.tone}`}>
      {confirm ? <>
        <span>{confirm === 'reload' ? 'Descartar o que você editou aqui e trazer a versão do PC?' : 'Gravar a sua versão por cima da que está no PC? O que mudou lá se perde.'}</span>
        <span className="file-notice-actions">
          <button onClick={() => setConfirm(null)}>Cancelar</button>
          <button className="danger-button" onClick={() => {
            setConfirm(null)
            if (confirm === 'reload') discard()
            else void overwrite()
          }}>{confirm === 'reload' ? 'Descartar e recarregar' : 'Confirmar e salvar'}</button>
        </span>
      </> : <>
        <span>{notice.text}</span>
        {notice.tone === 'conflict' && <span className="file-notice-actions">
          {draft !== null && <button onClick={() => void openCompare()}>Comparar</button>}
          <button onClick={() => (draft === null ? discard() : setConfirm('reload'))}>Recarregar do PC</button>
          {draft !== null && <button onClick={() => setConfirm('overwrite')}>Salvar por cima</button>}
        </span>}
        {notice.gone && draft !== null && <span className="file-notice-actions"><button onClick={() => void copyText(draft).then(() => setNotice({ tone: 'info', text: 'O que você editou foi copiado.' }), (error: Error) => setNotice({ tone: 'error', text: error.message }))}>Copiar o que editei</button></span>}
        {notice.downloaded && <span className="file-notice-actions"><button onClick={openDownloaded}>Abrir</button></span>}
        {notice.tone === 'error' && failed.current && <span className="file-notice-actions"><button onClick={() => void load(true)}>Tentar de novo</button></span>}
        {notice.tone !== 'conflict' && <button className="icon-button" aria-label="Dispensar aviso" onClick={() => setNotice(null)}><Icon name="fechar" /></button>}
      </>}
    </div>}
    <div className="file-body">
      {!file && !raw && loading && <SkeletonCode label="Abrindo o arquivo…" />}
      {!file && !raw && !loading && (stat?.exists
        ? <ExternalCard name={name} size={stat.size} reason="Não deu para abrir este arquivo no celular." onDownload={downloadAction} />
        : <div className="file-retry"><button onClick={() => void load(true)}><Icon name="atualizar" />Tentar de novo</button></div>)}
      {codeShown && <CodeEditor key={path} path={path} text={shown} revision={revision} dark={dark} editable={mode === 'edit'} line={line} handle={editor} onChange={(text) => setDraft(text === file.content ? null : text)} />}
      {codeShown && <button className="copy-fab" aria-label={selecting ? 'Copiar seleção' : 'Copiar tudo'} onPointerDown={() => { selectedAtTouch.current = editor.current?.selected() ?? '' }} onMouseDown={(event) => event.preventDefault()} onClick={copy}><Icon name="copiar" />{selecting ? 'Copiar seleção' : 'Copiar tudo'}</button>}
      {viewer === 'markdown' && file && mode === 'view' && <article ref={articleRef} className="markdown-view" onClick={(event) => {
        const link = (event.target as HTMLElement).closest('a')
        if (!link) return
        event.preventDefault()
        // Link para outro arquivo do projeto abre aqui mesmo; link da internet vai para o navegador.
        const href = link.getAttribute('href')
        if (href !== null) openMarkdownLink(href)
      }} dangerouslySetInnerHTML={{ __html: rendered }} />}
      {viewer === 'html' && raw && mode === 'view' && <>
        <div className="file-hint">
          <span>{draft !== null ? 'Mostrando a versão salva. Salve para ver as alterações aqui.' : 'Prévia na largura do celular.'}</span>
          {/* No navegador do celular a página carrega inteira, com zoom; o app Android leva este link para lá. */}
          <a className="open-full" href={new URL(raw, location.origin).href} target="_blank" rel="noopener"><Icon name="externo" />Abrir página inteira</a>
        </div>
        {/* Sem allow-same-origin: a página do projeto roda numa origem própria e vazia, sem alcançar esta página, o
            cookie do celular nem a API do PC. O link de leitura manda o mesmo sandbox no cabeçalho. */}
        <iframe title={name} className="html-view" sandbox="allow-scripts allow-popups" referrerPolicy="no-referrer" src={`${raw}?v=${file?.mtimeMs ?? 0}`} />
      </>}
      {viewer === 'svg' && raw && mode === 'view' && <>
        {draft !== null && <div className="file-hint"><span>Mostrando a versão salva. Salve para ver as alterações aqui.</span></div>}
        <ImagePage src={`${raw}?v=${file?.mtimeMs ?? 0}`} name={name} onTap={immerse} onError={() => setNotice({ tone: 'error', text: 'Não deu para desenhar este SVG. Use o Editar para ver o código.' })} />
      </>}
      {viewer === 'csv' && csvRows && <SheetPage all={csvRows} jumpRecord={csvJump} />}
      {viewer === 'notebook' && file && mode === 'view' && <NotebookPage text={shown} onLink={(href) => { if (/^https?:\/\//i.test(href)) window.open(href) }} />}
      {viewer === 'xlsx' && raw && (book.status === 'ask'
        ? <div className="external-card"><Icon name="planilha" /><strong>{name}</strong><p>Planilha grande para o celular: abrir pode deixar o app lento.</p><button onClick={() => setBigAllowed(true)}>Abrir mesmo assim</button>{downloadAction && <button className="primary" onClick={downloadAction}><Icon name="baixar" />Baixar para o celular</button>}</div>
        : book.status === 'too-large' ? <ExternalCard name={name} size={book.size} reason="Planilha grande demais para abrir no celular." onDownload={downloadAction} />
        : book.status === 'error' ? <ExternalCard name={name} size={size} reason={`Não deu para ler a planilha: ${book.message}`} onDownload={downloadAction} />
        : book.status === 'loading' || !sheetRows ? <SkeletonCode label="Lendo a planilha…" />
        : 'error' in sheetRows ? <ExternalCard name={name} size={size} reason={`Não deu para ler esta folha: ${sheetRows.error}`} onDownload={downloadAction} />
        : <SheetPage key={sheet} all={sheetRows.rows} jumpRecord={line !== null && sheetRows.rows.length > 0 ? Math.min(line, sheetRows.rows.length) - 1 : null} tabs={workbook?.sheets} tab={sheet} onTab={setSheetIndex} />)}
      {viewer === 'image' && raw && <ImagePage src={raw} name={name} onTap={immerse} onError={() => {
        failed.current = true
        setNotice({ tone: 'error', text: 'Não deu para trazer a imagem do PC. Ela abre de novo quando a conexão voltar.' })
      }} />}
      {viewer === 'pdf' && raw && <PdfPages url={raw} controls={!immersive} compact={landscape} page={line} onTap={immerse} onError={() => { failed.current = true }} />}
      {viewer === 'audio' && raw && <div className="audio-view">
        <Icon name="microfone" />
        <strong>{name}</strong>
        <audio controls preload="metadata" src={raw} aria-label={`Tocar ${name}`} onError={() => {
          failed.current = true
          setNotice({ tone: 'error', text: 'Não deu para tocar este áudio aqui. Baixe para abrir com outro app do celular.' })
        }} />
      </div>}
      {/* O player pede pedaços (Range) ao link de leitura: avança sem baixar o vídeo inteiro. */}
      {viewer === 'video' && raw && <video className="video-view" controls playsInline preload="metadata" src={raw} aria-label={`Tocar ${name}`} onError={() => {
        failed.current = true
        setNotice({ tone: 'error', text: 'Não deu para tocar este vídeo aqui. Baixe para abrir com outro app do celular.' })
      }} />}
      {viewer === 'external' && <ExternalCard name={name} size={size} reason={unavailable} onDownload={downloadAction} />}
      {compare && <DiffPanel pc={compare.pc} error={compare.error} mine={shown} onClose={() => setCompare(null)} />}
    </div>
  </main>
}
