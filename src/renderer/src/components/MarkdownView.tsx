import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import DOMPurify from 'dompurify'
import { cn } from '@/lib/utils'
import { ALLOWED_URI, findAnchor, headingSlug, isSameDocument, resolveImageSrc, resolveMarkdownHref } from '@/lib/markdown-links'
import { markdownBlocks } from '@/lib/markdown-scroll'
import { renderMermaidBlocks } from '@/lib/mermaid-blocks'
import { hasConflictBlocks } from '@/lib/git-conflicts'
import { useSaveShortcut } from '@/lib/use-save-shortcut'
import { touchesFile } from '@shared/file-change'
import { viewerFor } from '@shared/file-kind'
import { ViewerHeader } from '@/components/ViewerHeader'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { ModeToggle, type MarkdownMode } from '@/components/ModeToggle'
import { ViewerBoundary } from '@/components/ViewerBoundary'
import { BannerSlot } from '@/lib/banner-slot'
import { useConfirm } from '@/components/ConfirmDialog'
import { ensureRoom } from '@/lib/memory-budget'
import { tightMessage } from '@/lib/memory-tabs'
import { estimatedCost, formatMegabytes, markdownPreviewDecision, OPEN_LIMITS } from '@shared/open-limits'

// Puxa o Monaco: só carrega quando a visualização precisa do texto não salvo do editor.
const LiveMarkdownView = lazy(() => import('@/components/MarkdownLive').then((m) => ({ default: m.LiveMarkdownView })))

interface Props {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  fontSize: number
  onModeChange(mode: MarkdownMode): void
  onOpenPath(rel: string, line: number | null): void
  // Abrir um .md vazio vai direto para Editar (uma vez por arquivo na sessão, para "Visualizar" não voltar sozinho).
  autoEditEmpty?: boolean
  // Texto ainda não salvo do editor; sem ele, mostra o que está no disco.
  live?: string
  // A metade direita do lado a lado: sem o cabeçalho do arquivo, que fica no editor.
  bare?: boolean
  scrollerRef?: React.RefObject<HTMLDivElement | null>
  // Com texto não salvo: o Salvar do cabeçalho, já que o do editor está escondido.
  onSave?(): void
  // Onde as faixas do editor escondido aparecem (conflito com o disco e afins).
  bannerSlotRef?(element: HTMLDivElement | null): void
}

const autoEdited = new Set<string>()
// Markdown grande demais para desenhar abre em Editar uma vez por arquivo na sessão; voltar a Visualizar mostra o aviso.
const bigAutoEdited = new Set<string>()

const NOTICE_MS = 4000

const subscribeTheme = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
const isDarkDocument = (): boolean => document.documentElement.classList.contains('dark')

// Seção pedida por um link `outro.md#secao` de outra aba: a visualização do destino rola até ela quando o documento
// aparece. Pedido velho (o destino abriu em Editar e ficou lá) não rola mais tarde, do nada.
const ANCHOR_TTL_MS = 10_000
const pendingAnchors = new Map<string, { anchor: string; at: number }>()
const anchorListeners = new Set<() => void>()
const anchorKey = (projectId: string, path: string): string => `${projectId}\n${path.replace(/\//g, '\\').toLowerCase()}`

function requestAnchor(projectId: string, path: string, anchor: string): void {
  pendingAnchors.set(anchorKey(projectId, path), { anchor, at: Date.now() })
  for (const listener of anchorListeners) listener()
}

function takeAnchor(projectId: string, path: string): string | null {
  const key = anchorKey(projectId, path)
  const pending = pendingAnchors.get(key)
  if (!pending) return null
  pendingAnchors.delete(key)
  return Date.now() - pending.at <= ANCHOR_TTL_MS ? pending.anchor : null
}

const LINE_MARKER = 'data-md-line'

function renderMarkdown(source: string, projectId: string, docPath: string): string {
  // Um marcador antes de cada bloco, tudo numa string só: sanitizar bloco a bloco quebraria o HTML que abre num
  // bloco e fecha em outro (<details> com Markdown dentro).
  const html = markdownBlocks(source)
    .map((block) => `<span ${LINE_MARKER}="${block.line}"></span>${block.html}`)
    .join('')
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ALLOWED_URI_REGEXP: ALLOWED_URI })
  // A linha vai para o elemento do bloco (o que a rolagem mede); o marcador sai para não mexer no layout.
  for (const marker of fragment.querySelectorAll(`span[${LINE_MARKER}]`)) {
    const next = marker.nextElementSibling
    if (next && !next.hasAttribute(LINE_MARKER) && !next.hasAttribute('data-line')) next.setAttribute('data-line', marker.getAttribute(LINE_MARKER) ?? '')
    marker.remove()
  }
  // data-anchor em vez de id: id vindo do documento pode sombrear propriedades do window/document.
  const seen = new Map<string, number>()
  for (const heading of fragment.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    heading.setAttribute('data-anchor', headingSlug(heading.textContent ?? '', seen))
  }
  for (const img of fragment.querySelectorAll('img')) {
    const src = img.getAttribute('src')
    const resolved = src === null ? null : resolveImageSrc(src, docPath, projectId)
    if (resolved) img.setAttribute('src', resolved)
    else img.removeAttribute('src')
    img.removeAttribute('srcset')
  }
  for (const code of fragment.querySelectorAll('pre > code.language-mermaid')) code.parentElement?.setAttribute('data-mermaid', '')
  const box = document.createElement('div')
  box.append(fragment)
  return box.innerHTML
}

export function MarkdownView({
  projectId,
  projectPath,
  path,
  visible,
  fontSize,
  onModeChange,
  onOpenPath,
  autoEditEmpty = false,
  live,
  bare = false,
  scrollerRef,
  onSave,
  bannerSlotRef
}: Props): React.JSX.Element {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const diagrams = useRef({ dark: false, byIndex: new Map<number, string>() })
  const onModeChangeRef = useRef(onModeChange)
  const fromDisk = live === undefined
  const dark = useSyncExternalStore(subscribeTheme, isDarkDocument)

  useEffect(() => {
    onModeChangeRef.current = onModeChange
  }, [onModeChange])

  useEffect(() => {
    if (!fromDisk) return
    let cancelled = false
    window.kora.readText(projectId, path).then(
      (file) => {
        if (cancelled) return
        setSource(file.content)
        setError(null)
        const key = `${projectId}\n${path}`
        // Com marcadores de conflito o Visualizar esconderia os <<<<<<<; o editor mostra os blocos e as ações.
        if (autoEditEmpty && (file.content.trim() === '' || hasConflictBlocks(file.content)) && !autoEdited.has(key)) {
          autoEdited.add(key)
          onModeChangeRef.current('edit')
        }
      },
      (err: unknown) => {
        if (cancelled) return
        const message = ipcErrorMessage(err, path)
        setError(message)
        // Acima do limite do editor nem a leitura passa: o Editar oferece o "Abrir mesmo assim".
        const key = `${projectId}
${path}`
        if (!bare && message.startsWith('Arquivo grande demais') && !bigAutoEdited.has(key)) {
          bigAutoEdited.add(key)
          onModeChangeRef.current('edit')
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [projectId, path, reloadKey, fromDisk, autoEditEmpty, bare])

  // Só leitura, sem nada a perder: mudou no disco, relê. Arquivo que sumiu fica com o último conteúdo.
  useEffect(() => {
    if (!fromDisk) return
    let cancelled = false
    const off = window.kora.onFilesChanged((changedProject, change) => {
      if (changedProject !== projectId || !touchesFile(change, path)) return
      window.kora.readText(projectId, path).then(
        (file) => !cancelled && setSource(file.content),
        () => {}
      )
    })
    return () => {
      cancelled = true
      off()
    }
  }, [projectId, path, fromDisk])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const text = live ?? source
  const confirm = useConfirm()
  const [allowBig, setAllowBig] = useState(false)
  useEffect(() => setAllowBig(false), [projectId, path])
  const decision = text === null ? 'render' : markdownPreviewDecision(text.length, allowBig)
  const html = useMemo(
    () => (text === null || decision !== 'render' ? '' : renderMarkdown(text, projectId, path)),
    [text, projectId, path, decision]
  )
  useEffect(() => {
    if (bare || decision === 'render' || !fromDisk) return
    const key = `${projectId}
${path}`
    if (bigAutoEdited.has(key)) return
    bigAutoEdited.add(key)
    onModeChangeRef.current('edit')
  }, [bare, decision, fromDisk, projectId, path])

  const previewAnyway = async (): Promise<void> => {
    const room = await ensureRoom(estimatedCost('markdown-preview', text?.length ?? 0))
    if (room.status === 'tight' && !(await confirm({ title: 'Visualizar mesmo assim?', message: tightMessage(room.usedMB), confirmLabel: 'Visualizar mesmo assim', danger: true }))) return
    setAllowBig(true)
  }

  // Layout effect: o diagrama que já está no cache entra antes da pintura, sem piscar o código a cada tecla.
  useLayoutEffect(() => {
    const article = articleRef.current
    if (!article) return
    if (diagrams.current.dark !== dark) diagrams.current = { dark, byIndex: new Map() }
    let current = true
    void renderMermaidBlocks(article, dark, diagrams.current.byIndex, () => current)
    return () => {
      current = false
    }
  }, [html, dark])

  const scrollToAnchor = (anchor: string): void => {
    const found = articleRef.current && findAnchor(articleRef.current, anchor)
    if (found) found.scrollIntoView({ block: 'start' })
    else setNotice(`Seção não encontrada: #${anchor}`)
  }

  const [anchorRequests, setAnchorRequests] = useState(0)
  useEffect(() => {
    const listener = (): void => setAnchorRequests((n) => n + 1)
    anchorListeners.add(listener)
    return () => {
      anchorListeners.delete(listener)
    }
  }, [])

  // Só a aba que ficou na frente atende: o mesmo arquivo pode estar aberto em outra, escondida.
  useEffect(() => {
    if (!visible || !html || !articleRef.current) return
    const anchor = takeAnchor(projectId, path)
    if (anchor !== null) scrollToAnchor(anchor)
    // scrollToAnchor só lê refs e o setNotice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, html, anchorRequests, projectId, path])

  const openLink = async (href: string): Promise<void> => {
    const target = resolveMarkdownHref(href, path)
    if (target.kind === 'external') window.open(target.url)
    else if (target.kind === 'blocked') setNotice(target.message)
    else if (target.kind === 'anchor') scrollToAnchor(target.anchor)
    else if (target.kind === 'file') {
      if (target.anchor !== null && isSameDocument(target.rel, path)) return scrollToAnchor(target.anchor)
      const found = target.rel ? await window.kora.resolveTerminalLink(projectId, target.rel).catch(() => null) : null
      if (!found) return setNotice(`Arquivo não encontrado: ${target.rel.replace(/\\/g, '/') || '/'}`)
      if (target.anchor !== null && viewerFor(found.rel) === 'markdown') requestAnchor(projectId, found.rel, target.anchor)
      onOpenPath(found.rel, target.line)
    }
  }

  const onReload = (): void => {
    if (fromDisk) setReloadKey((k) => k + 1)
    else setNotice('Há alterações não salvas: para recarregar do disco, use o modo Editar')
  }

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-canvas', !visible && 'invisible')}>
      {bare ? (
        <div className="flex h-8 shrink-0 items-center border-b px-4 text-xs text-muted-foreground">Visualização</div>
      ) : (
        <ViewerHeader projectId={projectId} projectPath={projectPath} path={path} onOpenPath={onOpenPath} onReload={onReload}>
          {!fromDisk && (
            <span className="flex shrink-0 items-center gap-1.5 text-amber-300" data-tip="Mostrando as alterações não salvas" data-tip-shortcut="Ctrl+S">
              <span className="size-1.5 rounded-full bg-current" />
              Não salvo
            </span>
          )}
          {!fromDisk && onSave && (
            <button
              type="button"
              data-tip="Salvar"
              data-tip-shortcut="Ctrl+S"
              onClick={onSave}
              className="shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-secondary"
            >
              Salvar
            </button>
          )}
          <ModeToggle mode="preview" onChange={onModeChange} />
        </ViewerHeader>
      )}
      {!bare && bannerSlotRef && <div ref={bannerSlotRef} className="flex shrink-0 flex-col" />}
      {/* Selecionável até a borda, não só a coluna do texto: botão direito e arrastar a seleção funcionam também
          nas margens e abaixo do fim do documento. */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto select-text">
        {error && fromDisk ? (
          <p className="p-4 text-xs text-destructive">{error}</p>
        ) : text === null ? (
          <p className="p-4 text-xs text-muted-foreground">Carregando…</p>
        ) : text.trim() === '' ? (
          <p className="p-4 text-xs text-muted-foreground">Documento vazio.</p>
        ) : decision !== 'render' ? (
          <div className="flex flex-col items-start gap-2 p-4 text-xs text-muted-foreground">
            <p>
              {decision === 'ask'
                ? `Visualização pausada: este Markdown tem ${formatMegabytes(text.length)}, e desenhá-lo ocupa muita memória (cerca de 450 vezes o tamanho do texto).`
                : `Grande demais para visualizar aqui (${formatMegabytes(text.length)}; o limite é ${formatMegabytes(OPEN_LIMITS.forcedMarkdownPreviewBytes)}): o desenho ocuparia memória a ponto de derrubar a janela.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {!bare && (
                <button type="button" onClick={() => onModeChange('edit')} className="rounded-md border px-2.5 py-1 hover:bg-secondary hover:text-foreground">
                  Editar
                </button>
              )}
              {decision === 'ask' && (
                <button type="button" onClick={() => void previewAnyway()} className="rounded-md border px-2.5 py-1 hover:bg-secondary hover:text-foreground">
                  Visualizar mesmo assim
                </button>
              )}
            </div>
          </div>
        ) : (
          <article
            key={dark ? 'dark' : 'light'}
            ref={articleRef}
            data-file-text
            style={{ fontSize }}
            className="markdown mx-auto max-w-3xl px-6 py-5"
            onClick={(e) => {
              const link = (e.target as HTMLElement).closest('a')
              if (!link) return
              e.preventDefault()
              const href = link.getAttribute('href')
              if (href !== null) void openLink(href)
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
      {notice && (
        <div
          role="status"
          className="pointer-events-none absolute bottom-3 left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-md"
        >
          {notice}
        </div>
      )}
    </div>
  )
}

interface TabProps {
  projectId: string
  projectPath: string
  path: string
  visible: boolean
  fontSize: number
  mode: MarkdownMode
  dirty: boolean
  onModeChange(mode: MarkdownMode): void
  onOpenPath(rel: string, line: number | null): void
  // O CodeView da aba, ou null quando ele não precisa existir (Visualizar sem nada por salvar).
  editor: React.ReactNode
  // Salva pelo editor escondido: em Visualizar o Ctrl+S do Monaco não pega, o foco não está nele.
  onSave?(): void
}

// O editor fica montado (escondido) enquanto há alteração não salva: desmontar descartaria o model do Monaco, e a
// visualização lê o texto dele. A posição dos dois filhos não muda entre os modos para o React não recriar o editor.
export function MarkdownTab({ editor, mode, dirty, visible, onSave, ...view }: TabProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  useSaveShortcut(visible && mode === 'preview' && dirty, onSave)
  const onModeChange = view.onModeChange
  const banners = useMemo(() => ({ slot: mode === 'preview' ? slot : null, reveal: () => onModeChange('edit') }), [mode, slot, onModeChange])
  const fallback = <div className="absolute inset-0 bg-canvas" />
  return (
    <div className={cn('absolute inset-0 flex', !visible && 'invisible')}>
      <div ref={hostRef} className={mode === 'preview' ? 'invisible absolute inset-0' : 'relative min-w-0 flex-1'}>
        <BannerSlot.Provider value={banners}>{editor}</BannerSlot.Provider>
      </div>
      {mode !== 'edit' && (
        <div className={cn('relative min-w-0 flex-1', mode === 'split' && 'border-l')}>
          {/* Só a visualização cai: o editor ao lado guarda o model do Monaco com o que não foi salvo. */}
          <ViewerBoundary visible={visible} onEdit={() => view.onModeChange('edit')}>
            {mode === 'preview' && !dirty ? (
              <MarkdownView {...view} visible={visible} autoEditEmpty />
            ) : (
              <Suspense fallback={fallback}>
                <LiveMarkdownView
                  {...view}
                  visible={visible}
                  editorHost={hostRef}
                  bare={mode === 'split'}
                  followScroll={mode === 'split'}
                  onSave={onSave}
                  bannerSlotRef={mode === 'preview' ? setSlot : undefined}
                />
              </Suspense>
            )}
          </ViewerBoundary>
        </div>
      )}
    </div>
  )
}
