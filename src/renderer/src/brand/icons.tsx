import {
  ArrowDown,
  Bell,
  ArrowUp,
  Check,
  ListPlus,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  FileCode,
  FileImage,
  FileType,
  FolderGit2,
  GripVertical,
  FolderOpen,
  FolderPlus,
  Lock,
  Monitor,
  Moon,
  Pencil,
  Pin,
  RefreshCw,
  Settings,
  Sun,
  Trash2,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'

// Iconografia da identidade: grade de 24, traço 1,75, pontas redondas; contorno na cor do texto e no máximo
// um detalhe em âmbar (var(--icon-accent)), que fica cinza quando o ícone está inativo.
const STROKE = 1.75

type Draw = (accent: string) => React.JSX.Element

const BRAND = {
  projeto: (a) => (
    <>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.3a1.5 1.5 0 0 1 1.1.5l1.6 2Z" fill={a} stroke={a} />
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.3a1.5 1.5 0 0 1 1.1.5l1.6 2h7A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />
    </>
  ),
  novaAba: () => <path d="M12 5v14M5 12h14" />,
  terminal: (a) => (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M7 9.5l3 2.5-3 2.5" />
      <path d="M12.5 15H17" stroke={a} />
    </>
  ),
  agente: (a) => (
    <>
      <circle cx="12" cy="14" r="6" />
      <path d="M12 2.5v15" stroke={a} />
    </>
  ),
  sessoes: (a) => (
    <>
      <path d="M9.5 7H20M9.5 12H20M9.5 17H16" />
      <circle cx="5" cy="7" r="1.7" fill={a} stroke="none" />
      <circle cx="5" cy="12" r="1.7" fill={a} stroke="none" />
      <circle cx="5" cy="17" r="1.7" fill={a} stroke="none" />
    </>
  ),
  git: (a) => (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="7" r="2.2" fill={a} stroke={a} />
      <path d="M6 8.2v7.6M18 9.2c0 4.3-5.5 4.2-10.4 7.4" />
    </>
  ),
  arquivo: (a) => (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 16.5h4.5" stroke={a} />
    </>
  ),
  buscar: (a) => (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
      <path d="M7.8 11a3.2 3.2 0 0 1 3.2-3.2" stroke={a} />
    </>
  ),
  ajustes: (a) => (
    <>
      <path d="M4 7h8M17 7h3M4 17h3M12 17h8" />
      <circle cx="14.5" cy="7" r="2.3" fill={a} stroke={a} />
      <circle cx="9.5" cy="17" r="2.3" />
    </>
  ),
  retomar: (a) => <path d="M8 5.5v13l10.5-6.5z" fill={a} stroke={a} />,
  painel: (a) => (
    <>
      <path d="M15 4h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3z" fill={a} fillOpacity=".35" stroke="none" />
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M15 4v16" />
    </>
  ),
  fechar: () => <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
} satisfies Record<string, Draw>

// Ainda sem desenho na identidade: lucide no mesmo traço até a iconografia cobrir estes nomes.
const PROVISIONAL = {
  pastaAberta: FolderOpen,
  novoProjeto: FolderPlus,
  novaCategoria: ListPlus,
  codigo: FileCode,
  imagem: FileImage,
  pdf: FileType,
  fixar: Pin,
  copiar: Copy,
  excluir: Trash2,
  atualizar: RefreshCw,
  expandir: ChevronRight,
  editar: Pencil,
  visualizar: Eye,
  externo: ExternalLink,
  temaClaro: Sun,
  temaEscuro: Moon,
  temaSistema: Monitor,
  setaCima: ArrowUp,
  setaBaixo: ArrowDown,
  ok: Check,
  cadeado: Lock,
  alerta: TriangleAlert,
  worktree: FolderGit2,
  arrastar: GripVertical,
  engrenagem: Settings,
  sino: Bell
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof BRAND | keyof typeof PROVISIONAL

interface Props {
  name: IconName
  active?: boolean
  className?: string
}

export function Icon({ name, active = true, className }: Props): React.JSX.Element {
  if (!(name in BRAND)) {
    const Provisional = PROVISIONAL[name as keyof typeof PROVISIONAL]
    return <Provisional strokeWidth={STROKE} className={cn('size-4 shrink-0', className)} aria-hidden="true" />
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('size-4 shrink-0', className)}
    >
      {BRAND[name as keyof typeof BRAND](active ? 'var(--icon-accent)' : 'var(--icon-accent-idle)')}
    </svg>
  )
}
