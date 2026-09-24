import { test as base } from '@playwright/test'
import { launch, makeEnv, removeEnv, type KoraEnv, type KoraRun } from './kora'

interface Harness {
  env(opts?: { project?: boolean }): KoraEnv
  launch(env: KoraEnv): Promise<KoraRun>
}

export const test = base.extend<{ kora: Harness }>({
  kora: async ({}, use, testInfo) => {
    const envs: KoraEnv[] = []
    const runs: KoraRun[] = []
    await use({
      env: (opts) => {
        const env = makeEnv(opts)
        envs.push(env)
        return env
      },
      launch: async (env) => {
        const run = await launch(env)
        runs.push(run)
        return run
      }
    })
    const failed = testInfo.status !== testInfo.expectedStatus
    // O estado é anexado antes de fechar: fechar a janela roda uma detecção e mascararia o que o teste viu.
    if (failed) {
      for (const env of envs) {
        await testInfo.attach('kora-state-no-momento-da-falha.json', { path: env.stateFile }).catch(() => {})
      }
    }
    for (const run of runs) {
      if (failed) {
        await run.page
          .screenshot({ path: testInfo.outputPath(`falha-${runs.indexOf(run)}.png`) })
          .catch(() => {})
      }
      await run.closeWindow().catch(() => {})
      run.cleanupProcesses()
      if (failed && run.mainLog.length > 0) {
        await testInfo.attach(`main-${runs.indexOf(run)}.log`, { body: run.mainLog.join(''), contentType: 'text/plain' })
      }
    }
    for (const env of envs) {
      if (failed) {
        await testInfo.attach('fake-agents.log', { path: env.log }).catch(() => {})
        await testInfo.attach('lag.log', { path: env.userData + '/lag.log' }).catch(() => {})
        await testInfo.attach('kora-state.json', { path: env.stateFile }).catch(() => {})
      }
      removeEnv(env)
    }
  }
})

export { expect } from '@playwright/test'
