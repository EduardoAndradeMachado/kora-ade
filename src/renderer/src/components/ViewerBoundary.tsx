import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from '@/brand/icons'
import { Button } from '@/brand/Button'
import { cn } from '@/lib/utils'

interface Props {
  visible: boolean
  children: ReactNode
  // Saída para quando o que caiu foi a visualização: o editor de texto não passa pelo mesmo desenho.
  onEdit?(): void
}

interface State {
  error: Error | null
}

// Sem limite de erro, o React 19 desmonta a árvore inteira quando um componente lança ao desenhar: um arquivo que
// derruba o visualizador (Markdown aninhado demais estoura a pilha do marked) deixava a janela branca e levava junto
// os terminais e as edições não salvas das outras abas. Com ele, só esta aba troca pelo aviso.
export class ViewerBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
    window.kora.reportError(`visualizador de arquivo falhou ao desenhar: ${text}${info.componentStack ?? ''}`)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" className={cn('absolute inset-0 flex items-center justify-center bg-canvas px-6 py-8', !this.props.visible && 'invisible')}>
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          <Icon name="alerta" className="size-8 text-destructive" />
          <p className="text-sm font-medium">Não foi possível mostrar esta aba</p>
          <p className="max-w-full break-words text-xs text-muted-foreground">{error.message || error.name}</p>
          <p className="text-xs text-muted-foreground">As outras abas e os terminais seguem funcionando. O erro ficou no log de diagnóstico.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              <Icon name="atualizar" className="size-3.5 shrink-0" />
              Recarregar
            </Button>
            {this.props.onEdit && (
              <Button variant="secondary" onClick={this.props.onEdit}>
                <Icon name="codigo" className="size-3.5 shrink-0" />
                Abrir no editor
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
