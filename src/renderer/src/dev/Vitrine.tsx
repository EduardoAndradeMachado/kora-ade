import { useState } from 'react'
import type { UpdateStatus } from '@shared/update'
import { SettingsPanel } from '@/components/SettingsDialog'
import { cn } from '@/lib/utils'

// Só no `pnpm dev` (KORA_VITRINE=1): componentes reais em estados simulados, para escolher antes de aplicar no app.
const LAYOUTS = [{ label: 'C — só o logotipo, versão em etiqueta (escolhida)' }]

const STATES: { label: string; update: UpdateStatus }[] = [
  { label: 'Pronta', update: { state: 'ready', version: '0.2.0' } },
  { label: 'Baixando', update: { state: 'downloading', version: '0.2.0', percent: 63 } },
  { label: 'Em dia', update: { state: 'current', checkedAt: Date.now() } },
  { label: 'Erro', update: { state: 'error', message: 'sem conexão com o GitHub' } },
  { label: 'Fora do app instalado', update: { state: 'disabled' } }
]

export function Vitrine(): React.JSX.Element {
  const [stateIndex, setStateIndex] = useState(0)
  const [width, setWidth] = useState(448)
  const update = STATES[stateIndex]!.update

  return (
    <div className="h-full overflow-auto bg-background p-6 text-foreground">
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <span className="mr-2 text-sm font-semibold">Vitrine · Configurações</span>
        {STATES.map((s, i) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setStateIndex(i)}
            className={cn('rounded-md border px-2 py-1', i === stateIndex ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-secondary')}
          >
            {s.label}
          </button>
        ))}
        <span className="ml-4 text-muted-foreground">Largura</span>
        {[340, 448].map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWidth(w)}
            className={cn('rounded-md border px-2 py-1', w === width ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-secondary')}
          >
            {w} px
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-8">
        {LAYOUTS.map(({ label }) => (
          <section key={label} className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold">{label}</h2>
            <div className="flex flex-wrap gap-6">
              {(['light', 'dark'] as const).map((theme) => (
                <div
                  key={theme}
                  className={cn('rounded-xl bg-black/40 p-6', theme === 'dark' && 'dark')}
                  style={{ width: width + 48 }}
                >
                  <SettingsPanel
                    version="0.1.1"
                    update={update}
                    installing={false}
                    onCheck={() => {}}
                    onInstall={() => {}}
                    onClose={() => {}}
                  />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
