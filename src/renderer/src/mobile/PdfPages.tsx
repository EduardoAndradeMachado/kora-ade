import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Icon } from '@/brand/icons'
import { SkeletonPage } from './Skeleton'

// A página abre na largura da tela; a pinça, o duplo toque e os botões mudam o zoom sem tirar do lugar o ponto sob os
// dedos. Só as páginas perto da tela ocupam memória, e recarregar (o agente gerou o PDF de novo) volta ao mesmo lugar.
const GAP = 14
const NEAR = '600px 0px'
const CSS_PER_POINT = 96 / 72
const MIN_ZOOM = 0.25
const MAX_ZOOM = 5
const STEP = 1.25
// O canvas é redesenhado só depois que o gesto assenta; até lá o bitmap anterior é esticado.
const RENDER_DELAY_MS = 150
// Teto de pixels por canvas (o mesmo do leitor do pdf.js): acima disso o bitmap perde densidade, sem estourar a memória.
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
// Sem resposta do pdf.js nesse tempo, mostra o erro em vez de ficar carregando para sempre.
const OPEN_TIMEOUT_MS = 20_000
// O toque simples espera passar a janela do duplo toque (que é zoom) antes de esconder ou mostrar a barra.
const DOUBLE_TAP_MS = 300

const clampZoom = (scale: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))

type DocState = { kind: 'loading' } | { kind: 'ready'; doc: PDFDocumentProxy; ratio: number; points: number } | { kind: 'error'; message: string }
// Ponto que fica parado enquanto o zoom muda: a fração do conteúdo sob ele e a posição dele na área rolável.
interface Anchor { fx: number; fy: number; px: number; py: number }

const failure = (error: unknown): string =>
  error instanceof Error && error.name === 'PasswordException' ? 'o PDF é protegido por senha.' : error instanceof Error ? error.message : String(error)

export function PdfPages({ url, controls, onTap }: { url: string; controls: boolean; onTap(): void }): React.JSX.Element {
  const [state, setState] = useState<DocState>({ kind: 'loading' })
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const anchor = useRef<Anchor | null>(null)
  // Onde a leitura estava quando o PDF foi recarregado, para voltar a ela quando as páginas chegarem.
  const resume = useRef<{ fx: number; fy: number } | null>(null)
  const [current, setCurrent] = useState(1)
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(tapTimer.current), [])

  const points = state.kind === 'ready' ? state.points : 0
  const fit = points && width > GAP * 2 ? clampZoom((width - GAP * 2) / (points * CSS_PER_POINT)) : 1
  const scale = zoom === 'fit' ? fit : zoom
  const pageWidth = Math.round(points * CSS_PER_POINT * scale)
  const scaleRef = useRef(scale)
  useLayoutEffect(() => { scaleRef.current = scale }, [scale])

  useEffect(() => {
    let cancelled = false
    let destroy: (() => void) | undefined
    const timer = setTimeout(() => {
      if (!cancelled) setState((current) => (current.kind === 'loading' ? { kind: 'error', message: 'o PDF demorou mais de 20 segundos para abrir neste celular.' } : current))
    }, OPEN_TIMEOUT_MS)
    const element = scrollerRef.current
    if (element && element.scrollHeight > element.clientHeight) resume.current = { fx: element.scrollLeft / element.scrollWidth, fy: element.scrollTop / element.scrollHeight }
    setState({ kind: 'loading' })
    void (async () => {
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      if (cancelled) return
      // Sem estes caminhos, PDF escaneado (JBIG2) ou com imagem JPEG 2000 sai com a página em branco, sem aviso.
      const task = pdfjs.getDocument({ url, wasmUrl: '/pdfjs/wasm/', cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', iccUrl: '/pdfjs/iccs/' })
      destroy = () => void task.destroy()
      const doc = await task.promise
      const first = (await doc.getPage(1)).getViewport({ scale: 1 })
      if (!cancelled) setState({ kind: 'ready', doc, ratio: first.height / first.width, points: first.width })
    })().catch((error: unknown) => { if (!cancelled) setState({ kind: 'error', message: failure(error) }) })
    return () => {
      cancelled = true
      clearTimeout(timer)
      destroy?.()
    }
  }, [url])

  useEffect(() => {
    if (!scroller) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)))
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller])

  const zoomTo = (next: number, focus?: { x: number; y: number }): void => {
    const element = scrollerRef.current
    const target = clampZoom(next)
    if (!element || target === scaleRef.current) return
    const box = element.getBoundingClientRect()
    const px = focus ? focus.x - box.left : box.width / 2
    const py = focus ? focus.y - box.top : box.height / 2
    anchor.current = { fx: (element.scrollLeft + px) / element.scrollWidth, fy: (element.scrollTop + py) / element.scrollHeight, px, py }
    scaleRef.current = target
    setZoom(target)
  }
  const fitToScreen = (): void => {
    const element = scrollerRef.current
    if (!element || zoom === 'fit') return
    const py = element.clientHeight / 2
    anchor.current = { fx: 0, fy: (element.scrollTop + py) / element.scrollHeight, px: 0, py }
    setZoom('fit')
  }

  // Com as páginas já no tamanho novo, devolve a rolagem ao ponto que estava sob os dedos.
  useLayoutEffect(() => {
    const held = anchor.current
    const element = scrollerRef.current
    if (!held || !element) return
    anchor.current = null
    element.scrollLeft = held.fx * element.scrollWidth - held.px
    element.scrollTop = held.fy * element.scrollHeight - held.py
  }, [scale])

  useLayoutEffect(() => {
    const held = resume.current
    const element = scrollerRef.current
    if (state.kind !== 'ready' || !held || !element || width === 0) return
    resume.current = null
    element.scrollLeft = held.fx * element.scrollWidth
    element.scrollTop = held.fy * element.scrollHeight
  }, [state, width])

  // A página da vez é a que ocupa o meio da tela: no celular a rolagem é longa e o número evita se perder.
  useEffect(() => {
    if (!scroller || state.kind !== 'ready') return
    const update = (): void => {
      const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2
      const pages = [...scroller.querySelectorAll<HTMLElement>('.pdf-page')]
      const index = pages.findIndex((page) => page.getBoundingClientRect().bottom + GAP / 2 >= middle)
      setCurrent(index < 0 ? pages.length : index + 1)
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [scroller, state, pageWidth])

  // passive: false para a pinça não virar rolagem; um dedo só continua rolando a página normalmente.
  useEffect(() => {
    if (!scroller) return
    let pinch: { distance: number; scale: number } | null = null
    const distanceOf = (touches: TouchList): number => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY)
    const start = (event: TouchEvent): void => { pinch = event.touches.length === 2 ? { distance: distanceOf(event.touches), scale: scaleRef.current } : null }
    const move = (event: TouchEvent): void => {
      if (!pinch || event.touches.length !== 2) return
      event.preventDefault()
      const [a, b] = [event.touches[0]!, event.touches[1]!]
      zoomTo((pinch.scale * distanceOf(event.touches)) / pinch.distance, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 })
    }
    const end = (): void => { pinch = null }
    scroller.addEventListener('touchstart', start, { passive: true })
    scroller.addEventListener('touchmove', move, { passive: false })
    scroller.addEventListener('touchend', end)
    scroller.addEventListener('touchcancel', end)
    return () => {
      scroller.removeEventListener('touchstart', start)
      scroller.removeEventListener('touchmove', move)
      scroller.removeEventListener('touchend', end)
      scroller.removeEventListener('touchcancel', end)
    }
  }, [scroller])

  if (state.kind === 'error') return <p role="alert" className="error pdf-error">Não deu para abrir o PDF: {state.message}</p>

  // Arrastar e pinça não geram clique; o segundo toque de um duplo toque cancela o primeiro.
  const tap = (event: MouseEvent<HTMLDivElement>): void => {
    clearTimeout(tapTimer.current)
    if (event.detail > 1 || (event.target as Element).closest('a, button')) return
    tapTimer.current = setTimeout(onTap, DOUBLE_TAP_MS)
  }
  // Duplo toque alterna entre a página na largura da tela e o dobro dela, ampliando sob o dedo.
  const toggleZoom = (event: MouseEvent<HTMLDivElement>): void => {
    clearTimeout(tapTimer.current)
    if (zoom === 'fit') zoomTo(fit * 2, { x: event.clientX, y: event.clientY })
    else fitToScreen()
  }

  return <div className="pdf-view">
    <div className="pdf-scroller" ref={(element) => { scrollerRef.current = element; setScroller(element) }} style={{ padding: GAP }} onClick={tap} onDoubleClick={toggleZoom}>
      {state.kind === 'loading' ? <SkeletonPage label="Abrindo o PDF…" /> : width > 0 && (
        <div className="pdf-pages" style={{ gap: GAP }} aria-label={`PDF com ${state.doc.numPages} ${state.doc.numPages === 1 ? 'página' : 'páginas'}`}>
          {Array.from({ length: state.doc.numPages }, (_, index) => <PdfPage key={index} doc={state.doc} number={index + 1} width={pageWidth} ratio={state.ratio} root={scroller} />)}
        </div>
      )}
    </div>
    {state.kind === 'ready' && width > 0 && <div className={`pdf-zoom ${controls ? '' : 'hidden'}`} role="group" aria-label="Zoom">
      <span className="pdf-count" aria-label={`Página ${current} de ${state.doc.numPages}`}>{current} / {state.doc.numPages}</span>
      <button aria-label="Reduzir" disabled={scale <= MIN_ZOOM} onClick={() => zoomTo(scale / STEP)}><Icon name="menos" /></button>
      <button aria-label="Ajustar à tela" onClick={fitToScreen}>{Math.round(scale * 100)}%</button>
      <button aria-label="Ampliar" disabled={scale >= MAX_ZOOM} onClick={() => zoomTo(scale * STEP)}><Icon name="novaAba" /></button>
    </div>}
  </div>
}

function PdfPage({ doc, number, width, ratio, root }: { doc: PDFDocumentProxy; number: number; width: number; ratio: number; root: HTMLElement | null }): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [pageRatio, setPageRatio] = useState(ratio)
  const [renderWidth, setRenderWidth] = useState(width)
  const height = Math.round(width * pageRatio)

  useEffect(() => {
    const timer = setTimeout(() => setRenderWidth(width), RENDER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [width])

  useEffect(() => {
    const element = holder.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry!.isIntersecting), { root, rootMargin: NEAR })
    observer.observe(element)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    const target = canvas.current
    if (!target) return
    if (!near) {
      // Longe da tela: libera o bitmap; volta a desenhar quando a página se aproxima.
      target.width = 0
      target.height = 0
      return
    }
    let task: RenderTask | undefined
    let cancelled = false
    doc.getPage(number).then((page) => {
      if (cancelled) return
      const viewport = page.getViewport({ scale: renderWidth / page.getViewport({ scale: 1 }).width })
      const density = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)))
      // Desenha fora da tela e copia de uma vez: redimensionar o canvas visível o apaga, e a página piscaria a cada zoom.
      const buffer = document.createElement('canvas')
      buffer.width = Math.floor(viewport.width * density)
      buffer.height = Math.floor(viewport.height * density)
      setPageRatio(viewport.height / viewport.width)
      task = page.render({ canvas: buffer, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] })
      task.promise.then(() => {
        if (cancelled) return
        target.width = buffer.width
        target.height = buffer.height
        target.getContext('2d')?.drawImage(buffer, 0, 0)
      }, () => {
        // Cancelado ao rolar para longe, mudar o zoom ou fechar o arquivo.
      })
    }, () => {
      // Documento fechado (saiu do arquivo ou recarregou) com a página ainda a caminho.
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, number, renderWidth, near])

  return <div ref={holder} className="pdf-page" style={{ width, height }}>
    <canvas ref={canvas} style={{ width, height }} aria-label={`Página ${number}`} />
  </div>
}
