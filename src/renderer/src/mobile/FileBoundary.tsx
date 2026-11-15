import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from '@/brand/icons'

interface Props {
  path: string
  // Saída para quando o que caiu foi a visualização (Markdown aninhado demais estoura a pilha do marked): o editor
  // de texto não passa pelo mesmo desenho.
  canEdit: boolean
  onBack(): void
  children(startInEdit: boolean): ReactNode
}

interface State {
  error: Error | null
  edit: boolean
  attempt: number
}

// Mesmo papel do ViewerBoundary do PC: sem ele, o React desmonta o app inteiro do celular quando o visualizador lança
// ao desenhar, e a tela fica branca até recarregar. Com ele, só o arquivo troca pelo aviso, com o Voltar à mão.
export class FileBoundary extends Component<Props, State> {
  override state: State = { error: null, edit: false, attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('visualizador de arquivo falhou ao desenhar', error, info.componentStack)
  }

  private retry(edit: boolean): void {
    this.setState((s) => ({ error: null, edit: edit || s.edit, attempt: s.attempt + 1 }))
  }

  override render(): ReactNode {
    const { error, edit, attempt } = this.state
    if (!error) return <Fragment key={attempt}>{this.props.children(edit)}</Fragment>
    const name = this.props.path.split(/[\\/]/).pop() ?? this.props.path
    return (
      <main className="file-page">
        <div className="file-header">
          <button className="icon-button back-button" aria-label="Voltar" onClick={this.props.onBack}>
            <Icon name="expandir" className="back-icon" />
          </button>
          <span className="file-title">
            <strong>{name}</strong>
          </span>
        </div>
        <div role="alert" className="empty-state">
          <Icon name="alerta" />
          <h2>Não foi possível mostrar este arquivo</h2>
          <p>{error.message || error.name}</p>
          <button onClick={() => this.retry(false)}>
            <Icon name="atualizar" />
            Tentar de novo
          </button>
          {this.props.canEdit && !edit && (
            <button onClick={() => this.retry(true)}>
              <Icon name="editar" />
              Abrir no editor
            </button>
          )}
        </div>
      </main>
    )
  }
}
