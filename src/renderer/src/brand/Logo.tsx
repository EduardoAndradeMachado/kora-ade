import { cn } from '@/lib/utils'

type Level = 'full' | 'medium' | 'min'

// Um desenho só não aguenta de 256 a 16 px: completo a partir de 48, médio de 24 a 47, mínimo abaixo.
export const levelFor = (px: number): Level => (px >= 48 ? 'full' : px >= 24 ? 'medium' : 'min')

const line = (x1: number, y1: number, x2: number, y2: number, w: number): React.JSX.Element => (
  <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w} strokeLinecap="round" />
)

export function SymbolMark({
  size,
  level,
  body = 'var(--brand-body)',
  arm = 'var(--brand-line)',
  className
}: {
  size: number
  level?: Level
  body?: string
  arm?: string
  className?: string
}): React.JSX.Element {
  const lvl = level ?? levelFor(size)
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" className={cn('shrink-0', className)}>
      {lvl === 'full' && (
        <>
          <circle cx="50" cy="60" r="26" fill="none" stroke={body} strokeWidth="9" />
          <g stroke={arm}>
            {line(50, 8, 50, 82, 5.5)}
            {line(40, 46, 40, 74, 2.8)}
            {line(60, 46, 60, 74, 2.8)}
          </g>
        </>
      )}
      {lvl === 'medium' && (
        <>
          <circle cx="50" cy="60" r="25" fill="none" stroke={body} strokeWidth="11" />
          <g stroke={arm}>
            {line(50, 6, 50, 84, 8)}
            {line(38.5, 49, 38.5, 71, 3.6)}
            {line(61.5, 49, 61.5, 71, 3.6)}
          </g>
        </>
      )}
      {lvl === 'min' && (
        <>
          <circle cx="50" cy="58" r="27" fill="none" stroke={body} strokeWidth="15" />
          <g stroke={arm}>{line(50, 5, 50, 90, 13)}</g>
        </>
      )}
    </svg>
  )
}

// Símbolo mínimo recortado como o SVG oficial (docs/identidade-visual/svg/simbolo/simbolo-minimo-*): sem a
// margem do quadro 100x100, ocupa a altura inteira. Usado pequeno, no lugar de um ícone (ex.: aviso na aba).
export function SymbolCropped({ height, className }: { height: number; className?: string }): React.JSX.Element {
  return (
    <svg viewBox="14.5 -3.5 71 97" height={height} width={(height * 71) / 97} aria-hidden="true" className={cn('shrink-0', className)}>
      <circle cx="50" cy="58" r="27" fill="none" stroke="var(--brand-body)" strokeWidth="15" />
      <line x1="50" y1="5" x2="50" y2="61.25" stroke="var(--brand-line)" strokeWidth="13" strokeLinecap="round" />
    </svg>
  )
}

// Logotipo desenhado (sem fonte): o "o" é o anel atravessado pelo braço.
export function Wordmark({ height, plainO = false }: { height: number; plainO?: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 180 100" style={{ height, width: height * 1.8 }} aria-label="kora" className="shrink-0">
      <g fill="none" stroke="var(--brand-body)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="16" y1="12" x2="16" y2="86" />
        <polyline points="44,42 18,64" />
        <line x1="27" y1="57" x2="46" y2="86" />
        <line x1="104" y1="86" x2="104" y2="46" />
        <path d="M104 64 C104 51 112 45 124 45" />
        <circle cx="148" cy="65" r="20" />
        <line x1="168" y1="45" x2="168" y2="86" />
        <circle cx="72" cy="65" r="20" />
      </g>
      {!plainO && (
        <g stroke="var(--brand-line)" strokeLinecap="round">
          <line x1="72" y1="8" x2="72" y2="80" strokeWidth="3.4" />
          <line x1="66" y1="50" x2="66" y2="79" strokeWidth="1.8" />
          <line x1="78" y1="50" x2="78" y2="79" strokeWidth="1.8" />
        </g>
      )}
    </svg>
  )
}

export function Lockup({ height }: { height: number }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 leading-none">
      <Wordmark height={height} />
      <span className="text-[13px] tracking-[0.12em] text-muted-foreground">ADE</span>
    </span>
  )
}

// Carregamento: um ponto dá voltas em torno do braço, no sentido horário.
export function Loader({ size }: { size: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label="Carregando" className="shrink-0">
      <circle cx="50" cy="60" r="26" fill="none" stroke="var(--brand-body)" strokeWidth="9" opacity=".22" />
      <g stroke="var(--brand-line)">{line(50, 8, 50, 82, 5.5)}</g>
      <g className="kora-orbit">
        <circle cx="50" cy="34" r="7.5" fill="var(--brand-body)" />
      </g>
    </svg>
  )
}
