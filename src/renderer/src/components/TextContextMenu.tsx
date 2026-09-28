import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { ContextMenu, type MenuItem } from '@/components/ContextMenu'

// O Electron não tem menu de contexto padrão: sem isto, o botão direito num texto selecionável (o Markdown em
// visualização, uma mensagem de erro) não fazia nada. Quem já tem menu próprio (lateral, abas, árvore, Monaco)
// chama preventDefault e fica de fora; campo de texto e terminal também, que colar tem regras deles.
const EDITABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"], .xterm'

interface Open {
  x: number
  y: number
  text: string
  region: Element
}

const selectable = (el: Element): boolean => getComputedStyle(el).userSelect !== 'none'

// O bloco selecionável inteiro em volta do clique (o artigo do Markdown), não a janela: "Selecionar tudo" da
// janela pegaria a lateral e os painéis.
function regionOf(el: Element): Element {
  let region = el
  while (region.parentElement && selectable(region.parentElement)) region = region.parentElement
  return region
}

export function TextContextMenu(): React.JSX.Element | null {
  const [open, setOpen] = useState<Open | null>(null)

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      if (e.defaultPrevented || !(e.target instanceof Element)) return
      if (e.target.closest(EDITABLE) || !selectable(e.target)) return
      e.preventDefault()
      const text = window.getSelection()?.toString() ?? ''
      setOpen({ x: e.clientX, y: e.clientY, text, region: regionOf(e.target) })
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  if (!open) return null

  const items: MenuItem[] = [
    ...(open.text ? [{ label: 'Copiar', icon: <Icon name="copiar" />, onSelect: () => void navigator.clipboard.writeText(open.text) }] : []),
    {
      label: 'Selecionar tudo',
      icon: <Icon name="selecionarTudo" />,
      onSelect: () => window.getSelection()?.selectAllChildren(open.region)
    }
  ]
  return <ContextMenu x={open.x} y={open.y} items={items} onClose={() => setOpen(null)} />
}
