import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'

interface Props {
  projectId: string
  version: number
  open: boolean
}

export function ProjectAvatar({ projectId, version, open }: Props): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBroken(false)
    window.kora.projectIcon(projectId).then(
      (icon) => !cancelled && setSrc(icon),
      () => !cancelled && setSrc(null)
    )
    return () => {
      cancelled = true
    }
  }, [projectId, version])

  // data: URL, inclusive de SVG do repositório: só em <img>, que não executa script.
  if (src && !broken) {
    return <img src={src} alt="" onError={() => setBroken(true)} className="size-4 shrink-0 rounded-[3px] object-contain" />
  }
  return <Icon name="projeto" active={open} />
}
