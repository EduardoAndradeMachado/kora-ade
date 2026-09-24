import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_DIR, ROOT } from './kora'

// Build de produção numa pasta própria: `out/` é usada pelo `electron-vite dev` do dono.
export default function globalSetup(): void {
  if (process.env['KORA_E2E_BUILD'] || process.env['KORA_E2E_SKIP_BUILD'] || process.env['KORA_E2E_EXE']) return
  mkdirSync(BUILD_DIR, { recursive: true })
  writeFileSync(
    join(BUILD_DIR, 'package.json'),
    JSON.stringify({ name: 'kora-e2e', productName: 'Kora ADE E2E', version: '0.0.0', main: './out/main/index.js' }, null, 2)
  )
  // O main acha o ícone da janela e da bandeja por app.getAppPath(): sem ele não há bandeja, como no app real.
  cpSync(join(ROOT, 'resources'), join(BUILD_DIR, 'resources'), { recursive: true })
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--outDir', join(BUILD_DIR, 'out'), '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit' }
  )
}
