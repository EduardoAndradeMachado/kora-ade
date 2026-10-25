import { Loader } from '@/brand/Logo'

// Espera com a logo em movimento, no meio do espaço livre: o mesmo Loader do PC.
export function Loading({ label, size = 56 }: { label?: string; size?: number }): React.JSX.Element {
  return <div className="loading" role="status" aria-label={label ?? 'Carregando'}>
    <Loader size={size} />
    {label && <span>{label}</span>}
  </div>
}
