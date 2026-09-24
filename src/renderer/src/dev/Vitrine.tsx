import { cn } from '@/lib/utils'

// Vitrine de amostras, só no `pnpm dev` com KORA_VITRINE=1 (import.meta.env.DEV a tira do build de produção).
// Para testar uma parte da interface antes de aplicar no app: desenhe os componentes reais em estados simulados
// dentro de <Amostra>, uma por variante, e escolha olhando claro e escuro lado a lado. Decidido, a variante vai
// para o componente de verdade e a vitrine volta a ficar vazia.

export function Amostra({ titulo, detalhe, children }: { titulo: string; detalhe?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col">
        <h2 className="text-xs font-semibold">{titulo}</h2>
        {detalhe && <p className="text-[11px] text-muted-foreground">{detalhe}</p>}
      </div>
      <div className="flex flex-wrap gap-4">
        {(['light', 'dark'] as const).map((theme) => (
          <div key={theme} className={cn('rounded-xl bg-background p-4 text-foreground ring-1 ring-border', theme === 'dark' && 'dark')}>
            {children}
          </div>
        ))}
      </div>
    </section>
  )
}

export function Vitrine(): React.JSX.Element {
  return (
    <div className="h-full overflow-auto bg-background p-6 text-foreground">
      <h1 className="mb-1 text-sm font-semibold">Vitrine</h1>
      <p className="mb-6 text-xs text-muted-foreground">
        Sem amostras no momento. Para testar uma parte da interface, coloque cada variante num {'<Amostra>'} em
        src/renderer/src/dev/Vitrine.tsx.
      </p>
      <div className="flex flex-col gap-8" />
    </div>
  )
}
