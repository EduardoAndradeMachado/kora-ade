import { createRoot } from 'react-dom/client'
import './assets/main.css'
import './brand/tokens.css'
import { App } from './App'
import { ConfirmProvider } from './components/ConfirmDialog'

// Vitrine de desenvolvimento: fora do build de produção (import.meta.env.DEV some no empacotamento).
const vitrine = import.meta.env.DEV && location.hash === '#vitrine'
if (vitrine) {
  // O index.html nasce com "dark"; na vitrine cada amostra escolhe o tema, então a página começa clara.
  document.documentElement.classList.remove('dark')
  window.kora.setWindowDark(false)
  void import('./dev/Vitrine').then(({ Vitrine }) => createRoot(document.getElementById('root')!).render(<Vitrine />))
}

const dark = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => {
  document.documentElement.classList.toggle('dark', dark.matches)
  window.kora.setWindowDark(dark.matches)
}
if (!vitrine) {
  applyTheme()
  dark.addEventListener('change', applyTheme)
}

// Erro de script ou promessa rejeitada sem tratamento na interface vai para o log de erros do main.
const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : error === undefined ? fallback : String(error)
window.addEventListener('error', (event) => window.kora.reportError(errorText(event.error, event.message)))
window.addEventListener('unhandledrejection', (event) =>
  window.kora.reportError(`promessa rejeitada sem tratamento: ${errorText(event.reason, 'sem motivo')}`)
)

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
if (!vitrine) {
  createRoot(document.getElementById('root')!).render(
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  )
}
