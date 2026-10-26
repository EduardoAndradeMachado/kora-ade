import { Wordmark } from '@/brand/Logo'
import { Icon } from '@/brand/icons'

// Esqueleto: o formato do que vai aparecer, no lugar da logo girando. O que é fixo (logo, títulos, busca) já aparece
// de verdade; só o que vem do PC vira barra, e as linhas usam as mesmas classes das reais, para a troca não mexer na
// tela. Quem pede menos movimento no sistema vê o esqueleto parado. Os tamanhos seguem um padrão fixo, para não
// piscar a cada render.
const WIDTHS = ['72%', '54%', '86%', '46%', '64%', '78%', '58%', '90%', '42%', '68%', '82%', '50%']

export function Bar({ width = '100%', height }: { width?: string; height?: number }): React.JSX.Element {
  return <span className="skeleton-bar" style={{ width, height }} />
}

function Frame({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }): React.JSX.Element {
  return <div className={`skeleton ${className}`} role="status" aria-label={label} aria-busy="true">{children}</div>
}

// row: a classe da linha de verdade (file-row, folder-entry, session-row), que dá a mesma altura e o mesmo espaçamento.
export function SkeletonRows({ label, row, count = 6, detail = false }: { label: string; row: string; count?: number; detail?: boolean }): React.JSX.Element {
  return <Frame label={label} className="skeleton-list">
    {Array.from({ length: count }, (_, index) => <div className={`${row} skeleton-row`} key={index}>
      <span className="skeleton-bar skeleton-icon" />
      <span className="skeleton-row-text">
        <span className="skeleton-line"><Bar width={WIDTHS[index % WIDTHS.length]} /></span>
        {detail && <span className="skeleton-line skeleton-line-small"><Bar width="34%" height={8} /></span>}
      </span>
    </div>)}
  </Frame>
}

// Código: a coluna dos números de linha e as linhas na mesma altura do editor (13 px × 1,5).
export function SkeletonCode({ label }: { label: string }): React.JSX.Element {
  return <Frame label={label} className="skeleton-code">
    {Array.from({ length: 28 }, (_, index) => <div className="skeleton-code-line" key={index}>
      <span className="skeleton-bar skeleton-gutter" />
      <Bar width={WIDTHS[(index * 5) % WIDTHS.length]} height={9} />
    </div>)}
  </Frame>
}

// Terminal: linhas na altura das do xterm, sobre o fundo dele.
export function SkeletonTerminal({ label }: { label: string }): React.JSX.Element {
  return <Frame label={label} className="skeleton-terminal">
    {Array.from({ length: 22 }, (_, index) => <div className="skeleton-terminal-line" key={index}>
      <Bar width={WIDTHS[(index * 7) % WIDTHS.length]} height={8} />
    </div>)}
  </Frame>
}

export function SkeletonPage({ label }: { label: string }): React.JSX.Element {
  return <Frame label={label} className="skeleton-pages">
    <span className="skeleton-bar skeleton-page" />
    <span className="skeleton-bar skeleton-page" />
  </Frame>
}

// Um bloco por agente, com as mesmas classes dos de verdade: nome e as janelas de limite.
export function SkeletonUsage(): React.JSX.Element {
  return <Frame label="Carregando os limites de uso" className="skeleton-usage-list">
    {[0, 1].map((agent) => <div className="usage-agent" key={agent}>
      <div className="usage-agent-name"><span className="skeleton-bar skeleton-icon" /><span className="skeleton-line"><Bar width="92px" /></span></div>
      {[0, 1].map((limit) => <div className="usage-window" key={limit}>
        <div><span className="skeleton-line"><Bar width="96px" height={8} /></span><span className="skeleton-line"><Bar width="56px" height={8} /></span></div>
        <Bar height={6} />
        <span className="skeleton-line skeleton-line-small"><Bar width="52%" height={8} /></span>
      </div>)}
    </div>)}
  </Frame>
}

// Atalhos e caminho da escolha de pasta, que só chegam com a primeira pasta.
export function SkeletonPills(): React.JSX.Element {
  return <>{['92px', '128px', '84px'].map((width) => <span className="skeleton-bar skeleton-pill" key={width} style={{ width }} />)}</>
}

// A tela inicial enquanto o app conversa com o PC, com a mesma estrutura da de verdade.
export function SkeletonHome(): React.JSX.Element {
  return <div className="mobile-app" role="status" aria-label="Conectando ao PC…" aria-busy="true">
    <header className="mobile-header">
      <span className="home-button"><Wordmark height={28} /></span>
      <span className="connection-dot" aria-hidden="true" />
      <span className="header-spacer" />
      <span className="icon-button skeleton-static"><Icon name="novoProjeto" /></span>
    </header>
    <main className="project-list skeleton">
      <div className="section-heading"><div><span className="eyebrow">SEU COMPUTADOR</span><h1>Seus projetos</h1></div><span className="section-count"><span className="skeleton-bar skeleton-count" /></span></div>
      <div className="project-search skeleton-static"><Icon name="buscar" /><span className="skeleton-search-text">Buscar projetos e abas</span></div>
      <div className="project-tree">
        {Array.from({ length: 5 }, (_, index) => <div className="tree-project-row skeleton-row" key={index}>
          <span className="skeleton-tree-toggle" />
          <span className="skeleton-bar skeleton-icon" />
          <span className="skeleton-row-text"><span className="skeleton-line"><Bar width={WIDTHS[(index * 3) % WIDTHS.length]} /></span></span>
          <span className="skeleton-bar skeleton-icon skeleton-action" />
          <span className="skeleton-bar skeleton-icon skeleton-action" />
        </div>)}
      </div>
    </main>
    <footer className="mobile-footer"><span className="icon-button footer-settings skeleton-static"><Icon name="engrenagem" /></span></footer>
  </div>
}
