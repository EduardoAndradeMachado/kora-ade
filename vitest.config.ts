import { defineConfig } from 'vitest/config'

// Os grupos rodam um depois do outro. Juntos, os testes do relay (scrypt de 128 MiB por senha e Postgres em
// WebAssembly) tomavam a CPU da máquina do CI: o PowerShell levava mais de 15 s para mostrar o prompt, cada comando
// git levava segundos e os testes que esperam por processos estouravam o prazo.
const RELAY_TESTS = ['test/relay-accounts.test.ts', 'test/relay-service.test.ts']

// Abrem processos de verdade (PowerShell no ConPTY, git, Chromium, árvores de node) e esperam por eles: um arquivo
// por vez, para um não atrasar o outro.
const PROCESS_TESTS = [
  'test/agent.test.ts',
  'test/file-holders.test.ts',
  'test/git.test.ts',
  'test/job-object.test.ts',
  'test/mobile-server.test.ts',
  'test/mobile-ui.test.ts',
  'test/processes.test.ts',
  'test/process-registry.test.ts',
  'test/project-icon.test.ts',
  'test/relay-container.test.ts',
  'test/remote-mobile-server.test.ts',
  'test/resume-after-update.test.ts',
  'test/terminal-mirror.test.ts',
  'test/terminals.test.ts',
  'test/terminal-submit.test.ts'
]

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    projects: [
      { extends: true, test: { name: 'unidade', include: ['test/**/*.test.ts'], exclude: [...RELAY_TESTS, ...PROCESS_TESTS] } },
      { extends: true, test: { name: 'relay', include: RELAY_TESTS, sequence: { groupOrder: 1 } } },
      {
        extends: true,
        test: { name: 'processos', include: PROCESS_TESTS, fileParallelism: false, sequence: { groupOrder: 2 } }
      }
    ]
  }
})
