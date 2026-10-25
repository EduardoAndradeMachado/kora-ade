import { useEffect, useState } from 'react'

const BARS = 32

// Só as barras mudam a cada leitura: o nível chega a cada 80 ms e não deve redesenhar a sessão inteira.
export function VoiceMeter({ listen }: { listen(handler: ((level: number) => void) | null): void }): React.JSX.Element {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0))
  useEffect(() => {
    listen((level) => setLevels((current) => [...current.slice(1), level]))
    return () => listen(null)
  }, [listen])
  return <div className="voice-meter" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={1} aria-valuenow={levels.at(-1)}>
    {levels.map((level, index) => <span key={index} style={{ height: `${Math.max(8, Math.round(level * 100))}%` }} />)}
  </div>
}
