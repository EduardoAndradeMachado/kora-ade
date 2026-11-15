import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Icon } from '@/brand/icons'
import { ALLOWED_URI } from '@/lib/markdown-links'
import { loadNotebook } from '@/lib/notebook'
import { formatMegabytes } from '@shared/open-limits'
import { foldUnchanged, lineDiff } from './line-diff'

const DOUBLE_TAP_MS = 300

// Toque simples esconde o cromo (como no PDF); duplo toque alterna entre caber na tela e o tamanho real, com rolagem.
export function ImagePage({ src, name, onTap, onError }: { src: string; name: string; onTap(): void; onError(): void }): React.JSX.Element {
  const [actual, setActual] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const tap = (event: MouseEvent): void => {
    clearTimeout(timer.current)
    if (event.detail > 1) return
    timer.current = setTimeout(onTap, DOUBLE_TAP_MS)
  }
  return <div className={`image-view ${actual ? 'actual' : ''}`} onClick={tap} onDoubleClick={() => { clearTimeout(timer.current); setActual((on) => !on) }}>
    <img src={src} alt={name} onError={onError} />
  </div>
}

// Arquivo que o celular não desenha (zip, exe, docx) ou grande demais para ele: o tamanho e o caminho de baixar.
export function ExternalCard({ name, size, reason, onDownload }: { name: string; size: number | null; reason: string; onDownload?(): void }): React.JSX.Element {
  return <div className="external-card">
    <Icon name="arquivo" />
    <strong>{name}</strong>
    {size !== null && <small>{formatMegabytes(size)}</small>}
    <p>{reason}</p>
    {onDownload && <button className="primary" onClick={onDownload}><Icon name="baixar" />Baixar para o celular</button>}
  </div>
}

// Células do notebook como no PC (NotebookView): Markdown desenhado, código e saídas de texto e imagem. HTML e
// JavaScript das saídas ficam de fora, também como lá.
export function NotebookPage({ text, onLink }: { text: string; onLink(href: string): void }): React.JSX.Element {
  const load = useMemo(() => loadNotebook(text), [text])
  const markdown = useMemo(() => new Map(load.status === 'ready'
    ? load.notebook.cells.flatMap((cell, i) => (cell.type === 'markdown' ? [[i, DOMPurify.sanitize(marked.parse(cell.source, { async: false, gfm: true }), { ALLOWED_URI_REGEXP: ALLOWED_URI })] as const] : []))
    : []), [load])
  if (load.status === 'error') return <p role="alert" className="error notebook-error">Não deu para mostrar o notebook: {load.message}. Use o Editar para ver o JSON.</p>
  const { cells } = load.notebook
  return <div className="notebook-view" onClick={(event) => {
    const link = (event.target as HTMLElement).closest('a')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href')
    if (href) onLink(href)
  }}>
    {cells.length === 0 && <p className="empty-copy">Notebook sem células.</p>}
    {cells.map((cell, i) => {
      if (cell.type === 'markdown') return <article key={i} className="markdown-view notebook-markdown" dangerouslySetInnerHTML={{ __html: markdown.get(i) ?? '' }} />
      if (cell.type === 'raw') return <pre key={i} className="notebook-raw">{cell.source}</pre>
      return <section key={i} className="notebook-cell">
        <span className="notebook-prompt">In [{cell.count ?? ' '}]</span>
        <pre className="notebook-code">{cell.source}</pre>
        {cell.outputs.map((output, j) => output.kind === 'image'
          ? <img key={j} className="notebook-image" src={output.src} alt={`Saída ${j + 1} da célula ${i + 1}`} />
          : <pre key={j} className={`notebook-output ${output.stderr ? 'stderr' : ''}`}>{output.text}</pre>)}
      </section>
    })}
  </div>
}

// O "Comparar" do aviso de conflito: a versão do PC contra o que foi editado aqui, só a vizinhança do que mudou.
export function DiffPanel({ pc, error, mine, onClose }: { pc: string | null; error?: string; mine: string; onClose(): void }): React.JSX.Element {
  const rows = useMemo(() => (pc === null ? [] : foldUnchanged(lineDiff(pc, mine))), [pc, mine])
  const changed = rows.some((row) => row.kind === 'added' || row.kind === 'removed')
  return <section className="diff-view" aria-label="Comparação com o PC">
    <header className="diff-header">
      <span><span className="diff-key removed">− no PC</span><span className="diff-key added">+ aqui</span></span>
      <button onClick={onClose}><Icon name="fechar" />Fechar comparação</button>
    </header>
    {error ? <p role="alert" className="error diff-error">Não deu para trazer a versão do PC: {error}</p> : pc === null ? <p className="empty-copy">Trazendo a versão do PC…</p> : !changed ? <p className="empty-copy">As duas versões são iguais.</p>
      : <div className="diff-lines">{rows.map((row, i) => row.kind === 'skip'
        ? <div key={i} className="diff-line skip">{row.count === 1 ? '1 linha igual' : `${row.count.toLocaleString('pt-BR')} linhas iguais`}</div>
        : <div key={i} className={`diff-line ${row.kind}`}><span className="diff-number">{row.kind === 'added' ? row.after : row.before}</span><span className="diff-sign">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span><span className="diff-text">{row.text}</span></div>)}</div>}
  </section>
}
