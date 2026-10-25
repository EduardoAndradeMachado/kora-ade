import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // mobile.html é a página que o servidor do celular entrega; sai no mesmo build da janela.
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), mobile: resolve('src/renderer/mobile.html') } }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    // Sem isso o Vite descobre o Monaco (import lazy) no meio da sessão, reempacota as dependências e a página
    // passa a carregar duas cópias do React (hashes diferentes) — tela preta com "Invalid hook call". O CodeMirror
    // e o pdf.js são da página do celular: descobertos ao abrir um arquivo, o Vite a recarregaria no meio do uso.
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
        '@xterm/addon-webgl',
        'codemirror',
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/language',
        '@codemirror/language-data',
        '@codemirror/theme-one-dark',
        'pdfjs-dist'
      ]
    }
  }
})
