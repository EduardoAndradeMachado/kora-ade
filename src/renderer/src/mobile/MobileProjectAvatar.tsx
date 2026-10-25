import { useEffect, useState } from 'react'
import { Icon } from '@/brand/icons'
import { api } from './api'

export function MobileProjectAvatar({ id, path, open = false }: { id: string; path: string; open?: boolean }): React.JSX.Element {
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    setIcon(null)
    void api<{ icon: string | null }>(`project-icon?project=${encodeURIComponent(id)}`).then((result) => { if (!disposed) setIcon(result.icon) }).catch(() => {})
    return () => { disposed = true }
  }, [id, path])
  return icon ? <img className="project-avatar" src={icon} alt="" onError={() => setIcon(null)} /> : <Icon name="projeto" active={open} />
}
