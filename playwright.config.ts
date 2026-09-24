import { defineConfig } from '@playwright/test'

// Um Kora por vez: vários Electron + PowerShell em paralelo deixam a detecção de 2 s instável,
// e o teste de colar imagem usa o clipboard do sistema.
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  outputDir: './e2e/.results',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'e2e/.results/report.json' }]],
  use: { trace: 'retain-on-failure' }
})
