import { createRoot } from 'react-dom/client'
import './assets/main.css'
import './brand/tokens.css'
import { App } from './App'
import { ConfirmProvider } from './components/ConfirmDialog'

const dark = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => {
  document.documentElement.classList.toggle('dark', dark.matches)
  window.kora.setWindowDark(dark.matches)
}
applyTheme()
dark.addEventListener('change', applyTheme)

// Tarefa longa na interface (clique que não responde) vai para o lag.log do main, junto com os travamentos dele.
const LONG_TASK_MS = 300
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.duration > LONG_TASK_MS) window.kora.reportLongTask(entry.duration)
  }).observe({ type: 'longtask', buffered: false })
} catch {
  // Sem suporte a longtask o diagnóstico da interface só não existe.
}

// Sem StrictMode: o double-mount dele abriria e mataria o xterm de cada aba, perdendo a saída inicial do shell.
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <App />
  </ConfirmProvider>
)
