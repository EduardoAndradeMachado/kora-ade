import { cn } from '@/lib/utils'

// Iconografia da identidade: grade de 24, traço 1,75, pontas redondas; silhueta convencional, contorno na cor do
// texto e no máximo um detalhe em âmbar (var(--icon-accent)), que fica cinza quando o ícone está inativo.
// Ícones simples (setas, chevron, check, arrastar, +, X) ficam sem âmbar.
const STROKE = 1.75

type Draw = (accent: string) => React.JSX.Element

const FOLDER = 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.3a1.5 1.5 0 0 1 1.1.5l1.6 2h7A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z'
const PAGE = 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'
const GEAR =
  'M9.73 5.38 L10.17 2.98 L13.83 2.98 L14.27 5.38 L15.08 5.71 L17.08 4.33 L19.67 6.92 L18.29 8.92 L18.62 9.73 L21.02 10.17 L21.02 13.83 L18.62 14.27 L18.29 15.08 L19.67 17.08 L17.08 19.67 L15.08 18.29 L14.27 18.62 L13.83 21.02 L10.17 21.02 L9.73 18.62 L8.92 18.29 L6.92 19.67 L4.33 17.08 L5.71 15.08 L5.38 14.27 L2.98 13.83 L2.98 10.17 L5.38 9.73 L5.71 8.92 L4.33 6.92 L6.92 4.33 L8.92 5.71Z'

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
  fechar: () => <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  // Pastas: a aba âmbar é a mesma do ícone "projeto".
  pastaAberta: (a) => (
    <>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.3a1.5 1.5 0 0 1 1.1.5l1.6 2Z" fill={a} stroke={a} />
      <path d="M3 17V7.5A2.5 2.5 0 0 1 5.5 5h3.3a1.5 1.5 0 0 1 1.1.5l1.6 2h5A2.5 2.5 0 0 1 19 10v1" />
      <path d="M3 17.5 5.3 12.4A2.2 2.2 0 0 1 7.3 11h13.1a1.3 1.3 0 0 1 1.2 1.8l-2.2 5.5A2.6 2.6 0 0 1 17 20H5.5A2.5 2.5 0 0 1 3 17.5Z" />
    </>
  ),
  // Ações de criar: o "+" é o detalhe âmbar.
  novoProjeto: (a) => (
    <>
      <path d={FOLDER} />
      <path d="M12 10.5v6M9 13.5h6" stroke={a} />
    </>
  ),
  novaCategoria: (a) => (
    <>
      <path d="M4 7h11M4 12h7M4 17h7" />
      <path d="M17.5 11v7M14 14.5h7" stroke={a} />
    </>
  ),
  // Arquivos: a folha do "arquivo" com um detalhe âmbar que diz o tipo.
  codigo: (a) => (
    <>
      <path d={PAGE} />
      <path d="M14 3v5h5" />
      <path d="M10 12l-2.2 2.5L10 17M14 12l2.2 2.5L14 17" stroke={a} />
    </>
  ),
  imagem: (a) => (
    <>
      <path d={PAGE} />
      <path d="M14 3v5h5" />
      <circle cx="9.5" cy="11.5" r="1.4" fill={a} stroke={a} />
      <path d="M5 18l4-4 2.5 2.5L15 13l4 4" />
    </>
  ),
  pdf: (a) => (
    <>
      <path d={PAGE} />
      <path d="M14 3v5h5" stroke={a} />
      <path d="M8.5 13h7M8.5 16.5h4.5" />
    </>
  ),
  fixar: (a) => (
    <>
      <path d="M8.5 3.5h7" stroke={a} />
      <path d="M10 3.5v5L6.5 12.5h11L14 8.5v-5" />
      <path d="M12 12.5V21" />
    </>
  ),
  copiar: (a) => (
    <>
      <path d="M15.5 8.5V6A2 2 0 0 0 13.5 4H6A2 2 0 0 0 4 6v7.5a2 2 0 0 0 2 2h2.5" stroke={a} />
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    </>
  ),
  excluir: (a) => (
    <>
      <path d="M4 6.5h16M9.5 6.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
      <path d="M6 6.5l.9 12.6A2 2 0 0 0 8.9 21h6.2a2 2 0 0 0 2-1.9L18 6.5" />
      <path d="M10 10.5v6.5M14 10.5v6.5" stroke={a} />
    </>
  ),
  atualizar: (a) => (
    <>
      <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1" />
      <path d="M17.5 3v4h-4" stroke={a} />
      <path d="M6.5 21v-4h4" />
    </>
  ),
  expandir: () => <path d="M9.5 6l6 6-6 6" />,
  editar: (a) => (
    <>
      <path d="M15.5 4.5l4 4L9 19l-5 1 1-5z" />
      <path d="M5 15l4 4" stroke={a} />
    </>
  ),
  visualizar: (a) => (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" fill={a} stroke={a} />
    </>
  ),
  externo: (a) => (
    <>
      <path d="M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5" />
      <path d="M14 4h6v6M20 4l-9 9" stroke={a} />
    </>
  ),
  temaClaro: (a) => (
    <>
      <circle cx="12" cy="12" r="4" fill={a} stroke={a} />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  temaEscuro: (a) => (
    <>
      <path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10Z" />
      <circle cx="17" cy="6" r="1.1" fill={a} stroke={a} />
    </>
  ),
  temaSistema: (a) => (
    <>
      <path d="M5.5 4.5H12v11H5.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" fill={a} fillOpacity=".35" stroke="none" />
      <rect x="3.5" y="4.5" width="17" height="11" rx="2" />
      <path d="M12 15.5v4M8 19.5h8" />
    </>
  ),
  setaCima: () => <path d="M12 19V5M6 11l6-6 6 6" />,
  setaBaixo: () => <path d="M12 5v14M6 13l6 6 6-6" />,
  ok: () => <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cadeado: (a) => (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.5" r="1.4" fill={a} stroke={a} />
    </>
  ),
  alerta: (a) => (
    <>
      <path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.5" stroke={a} />
      <circle cx="12" cy="17" r=".6" fill={a} stroke={a} />
    </>
  ),
  worktree: (a) => (
    <>
      <path d={FOLDER} />
      <circle cx="9.5" cy="16.5" r="1.3" />
      <circle cx="14.5" cy="11.5" r="1.3" fill={a} stroke={a} />
      <path d="M9.5 15.2v-2.7M14.5 12.8c0 2-2.5 2.2-4 3" />
    </>
  ),
  arrastar: () => (
    <>
      <circle cx="9" cy="6" r=".9" fill="currentColor" />
      <circle cx="15" cy="6" r=".9" fill="currentColor" />
      <circle cx="9" cy="12" r=".9" fill="currentColor" />
      <circle cx="15" cy="12" r=".9" fill="currentColor" />
      <circle cx="9" cy="18" r=".9" fill="currentColor" />
      <circle cx="15" cy="18" r=".9" fill="currentColor" />
    </>
  ),
  engrenagem: (a) => (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="3" fill={a} stroke={a} />
    </>
  ),
  sino: (a) => (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 21a2 2 0 0 0 4 0" stroke={a} />
    </>
  )
} satisfies Record<string, Draw>

export type IconName = keyof typeof BRAND

interface Props {
  name: IconName
  // Detalhe âmbar: só no que está aberto, selecionado ou em uso agora (e nas ações de criar projeto e
  // categoria). Ícone aceso por padrão deixava a tela inteira parecendo "em uso".
  active?: boolean
  className?: string
}

export function Icon({ name, active = false, className }: Props): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={name}
      className={cn('size-4 shrink-0', className)}
    >
      {BRAND[name](active ? 'var(--icon-accent)' : 'var(--icon-accent-idle)')}
    </svg>
  )
}
