import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    // Sem isso o Vite descobre o Monaco (import lazy) no meio da sessão, reempacota as dependências e a página
    // passa a carregar duas cópias do React (hashes diferentes) — tela preta com "Invalid hook call".
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'monaco-editor',
        'marked',
        'dompurify',
        'lucide-react',
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-unicode11',
        '@xterm/addon-web-links',
        '@xterm/addon-webgl'
      ]
    }
  }
})
