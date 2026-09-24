// Planta um bug de cada vez numa CÓPIA de src/ (nunca no src/ real: o `electron-vite dev` do dono
// recarregaria a interface com o bug e o reload mata os terminais dele), builda a cópia e roda o
// teste que deveria pegar o bug. Mutante que deixa o teste verde = teste que não protege nada.
//
// Uso: node e2e/mutantes.mjs [id...]      (sem ids roda todos)
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'e2e', '.build')

const MUTANTS = [
  {
    id: 'M4',
    grep: 'R4 ',
    file: 'src/shared/agent.ts',
    bug: 'aba Claude nova sobe `claude` sem --session-id',
    find: '`claude --session-id ${startup.sessionId}`',
    replace: '`claude`'
  },
  {
    id: 'M5',
    grep: 'R5 ',
    file: 'src/shared/agent.ts',
    bug: 'Continuar chat do Claude usa --continue em vez de --resume <uuid>',
    find: '`claude --resume ${startup.sessionId}`',
    replace: '`claude --continue`'
  },
  {
    id: 'M6',
    grep: 'R6 ',
    file: 'src/main/store.ts',
    bug: 'estado gravado só na saída do processo (write-behind com flush no exit)',
    find: [
      '  const tmp = `${file}.tmp`',
      "  writeFileSync(tmp, JSON.stringify(valid, null, 2), 'utf8')",
      '  renameSync(tmp, file)',
      '}'
    ].join('\n'),
    replace: [
      '  pendingWrite = () => {',
      '    const tmp = `${file}.tmp`',
      "    writeFileSync(tmp, JSON.stringify(valid, null, 2), 'utf8')",
      '    renameSync(tmp, file)',
      '  }',
      '}',
      'let pendingWrite: (() => void) | null = null',
      'process.on("exit", () => pendingWrite?.())'
    ].join('\n')
  },
  {
    id: 'M7',
    grep: 'R7 ',
    file: 'src/main/projects.ts',
    bug: 'mergeTabs mantém abas que o renderer não mandou mais (aba fechada volta)',
    find: '  return { ...state, tabs }',
    replace:
      '  const kept = state.tabs.filter((t) => !incoming.some((i) => i.id === t.id))\n  return { ...state, tabs: [...tabs, ...kept] }'
  },
  {
    id: 'M8',
    grep: 'R8 ',
    file: 'src/main/agent-detect.ts',
    bug: 'dono do lock do Codex comparado com o PID do pai (ppid) em vez do próprio processo',
    find: 'const lock = codex.get(proc.pid)',
    replace: 'const lock = codex.get(proc.ppid)'
  },
  {
    id: 'M13',
    grep: 'R13 ',
    file: 'src/main/projects.ts',
    bug: 'mergeTabs descarta o titleLocked (nome do usuário perde a trava ao salvar)',
    find: 'titleLocked: t.titleLocked ?? false,',
    replace: 'titleLocked: false,'
  },
  {
    id: 'M13b',
    grep: 'R13 ',
    file: 'src/renderer/src/App.tsx',
    bug: 'título publicado pelo terminal sobrescreve o nome dado pelo usuário (autoTitle ignora titleLocked)',
    find: "!t.titleLocked ? { ...t, title } : t",
    replace: "true ? { ...t, title } : t"
  },
  {
    id: 'M14',
    grep: 'R14 ',
    file: 'src/main/terminals.ts',
    bug: 'kill() só esquece o pty sem encerrar o processo',
    find: '    this.sessions.get(id)?.kill()\n',
    replace: ''
  },
  {
    id: 'M42',
    grep: 'R42 ',
    file: 'src/renderer/src/components/CodeView.tsx',
    bug: 'botão Salvar aparece mas o clique não grava',
    find: 'onClick={() => void save()}',
    replace: 'onClick={() => {}}'
  },
  {
    id: 'M42b',
    grep: 'R42 ',
    file: 'src/renderer/src/components/CodeView.tsx',
    bug: 'salvamento automático a cada edição',
    find: 'loaded.onDidChangeContent(() => refreshDirty(loaded))',
    replace: 'loaded.onDidChangeContent(() => (refreshDirty(loaded), void saveRef.current()))'
  },
  {
    id: 'M43',
    grep: 'R43 ',
    file: 'src/renderer/src/components/CodeView.tsx',
    bug: 'editor aberto não acompanha a mudança do texto dos arquivos',
    find: '    editorRef.current?.updateOptions({ fontSize })\n',
    replace: ''
  },
  {
    id: 'M43b',
    grep: 'R43 ',
    file: 'src/renderer/src/lib/use-zoom-shortcuts.ts',
    bug: 'Ctrl + roda sobre o arquivo muda o zoom da interface',
    find: "else if (target?.closest('[data-file-text]')) onFileFont(direction)",
    replace: 'else if (false) onFileFont(direction)'
  },
  {
    id: 'M44',
    grep: 'R44 ',
    file: 'src/renderer/src/components/Sidebar.tsx',
    bug: 'clique do meio não fecha a aba na lateral',
    find: 'onAuxClick={(e) => e.button === 1 && props.onClose(tab.id)}',
    replace: 'onAuxClick={() => {}}'
  },
  {
    id: 'M45',
    grep: 'R45 ',
    file: 'src/renderer/src/components/Sidebar.tsx',
    bug: 'tema segue com o nome antigo',
    find: "label: 'Sistema'",
    replace: "label: 'Seguir o Windows'"
  },
  {
    id: 'M46',
    grep: 'R46 ',
    file: 'src/renderer/src/components/FileTree.tsx',
    bug: 'árvore só relê as pastas listadas no aviso; .gitignore novo não reconsulta os ignorados',
    find: 'const dirs = change.rescan || change.ignoreRules ? [...loadedRef.current] : change.dirs',
    replace: 'const dirs = change.dirs'
  },
  {
    id: 'M46b',
    grep: 'R46 ',
    file: 'src/renderer/src/lib/use-git.ts',
    bug: 'status do git ignora o aviso do watcher e só atualiza no polling',
    find: "if (changedProject !== projectId || !change.git) return",
    replace: 'return'
  },
  {
    id: 'M47',
    grep: 'R47 ',
    file: 'src/renderer/src/components/TerminalView.tsx',
    bug: 'terminal só aceita arrasto vindo do explorador do Kora',
    find: "if (!e.dataTransfer.types.includes(FILE_MIME) && !e.dataTransfer.types.includes('Files')) return",
    replace: 'if (!e.dataTransfer.types.includes(FILE_MIME)) return'
  },
  {
    id: 'M47b',
    grep: 'R47 ',
    file: 'src/preload/index.ts',
    bug: 'arquivo do sistema chega sem caminho (File.path não existe mais no Electron)',
    find: 'pathForFile: (file) => webUtils.getPathForFile(file),',
    replace: "pathForFile: (file) => (file as unknown as { path?: string }).path ?? '',"
  },
  {
    id: 'M47c',
    grep: 'R47 ',
    file: 'src/renderer/src/components/TerminalView.tsx',
    bug: 'caminho com espaço colado sem aspas',
    find: 'paths.filter(Boolean).map((path) => (path.includes(\' \') ? `"${path}"` : path))',
    replace: 'paths.filter(Boolean)'
  },
  {
    id: 'M48',
    grep: 'R48 ',
    file: 'src/renderer/src/App.tsx',
    bug: 'abas de arquivo continuam abertas depois do X',
    find: 'const offHidden = window.kora.onHidden(closeFileTabs)',
    replace: 'const offHidden = window.kora.onHidden(() => {})'
  },
  {
    id: 'M48b',
    grep: 'R48 ',
    file: 'src/main/index.ts',
    bug: 'X esconde na bandeja sem perguntar pelos arquivos não salvos',
    find: "    if (unsaved) askRenderer('hide')\n    else hideToTray()",
    replace: '    hideToTray()'
  },
  {
    id: 'M48c',
    grep: 'R4[89] ',
    file: 'src/renderer/src/App.tsx',
    bug: 'interface não avisa o main que há arquivo não salvo',
    find: 'useEffect(() => window.kora.setUnsaved(unsavedFiles), [unsavedFiles])',
    replace: 'useEffect(() => {}, [unsavedFiles])',
    expect: { 'R48 ': 'failed', 'R49 ': 'failed' }
  },
  {
    id: 'M49',
    grep: 'R49 ',
    file: 'src/main/index.ts',
    bug: 'Sair encerra sem perguntar pelos arquivos não salvos',
    find: 'if (unsaved && !quitConfirmed && mainWindow) {',
    replace: 'if (false) {'
  },
  {
    id: 'M49b',
    grep: 'R4[89] ',
    file: 'src/main/index.ts',
    bug: 'main não reconhece que a interface recebeu o pedido e fecha no tempo de segurança',
    find: "ipcMain.on('app:close-ack', () => clearTimeout(closeAckTimer))",
    replace: "ipcMain.on('app:close-ack', () => {})",
    expect: { 'R48 ': 'failed', 'R49 ': 'failed' }
  },
  {
    id: 'M50',
    grep: 'R50 ',
    file: 'src/renderer/src/App.tsx',
    bug: 'engrenagem não abre as Configurações',
    find: 'onOpenSettings={() => setSettingsOpen(true)}',
    replace: 'onOpenSettings={() => {}}'
  },
  {
    id: 'M50b',
    grep: 'R50 ',
    file: 'src/renderer/src/components/SettingsDialog.tsx',
    bug: 'Buscar atualização não chega ao main',
    find: 'onClick={props.onCheck}',
    replace: 'onClick={() => {}}'
  },
  {
    id: 'M50c',
    grep: 'R(50|36) ',
    file: 'src/preload/index.ts',
    bug: 'interface não recebe as mudanças de estado da atualização',
    find: "onUpdateStatus: (listener) => subscribe<[UpdateStatus]>('update:status', listener),",
    replace: 'onUpdateStatus: () => () => {},',
    expect: { 'R50 ': 'failed', 'R36 ': 'failed' }
  },
  {
    id: 'M50d',
    grep: 'R50 ',
    file: 'src/main/index.ts',
    bug: 'fora do app instalado a tela finge que pode buscar atualização',
    find: "updates?.status() ?? { state: 'disabled' }",
    replace: "updates?.status() ?? { state: 'idle' }"
  },
  {
    id: 'M36',
    grep: 'R36 ',
    file: 'src/renderer/src/App.tsx',
    bug: 'Atualizar agora instala sem perguntar pelos arquivos não salvos',
    find: "    if (!(await resolveUnsaved('quit'))) return false\n",
    replace: ''
  }
]

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function build(dir) {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--logLevel', 'error'], {
    cwd: dir,
    encoding: 'utf8'
  })
  return { ok: r.status === 0, log: (r.stdout ?? '') + (r.stderr ?? '') }
}

function runTests(dir, grep) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-g', grep, '--reporter=json'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KORA_E2E_BUILD: dir }, maxBuffer: 64 * 1024 * 1024 }
  )
  const results = {}
  try {
    const report = JSON.parse(r.stdout)
    const walk = (suite) => {
      for (const s of suite.suites ?? []) walk(s)
      for (const spec of suite.specs ?? []) {
        const last = spec.tests[0]?.results.at(-1)
        results[spec.title] = { status: last?.status ?? 'unknown', error: last?.error?.message?.split('\n')[0] ?? null }
      }
    }
    for (const s of report.suites) walk(s)
  } catch {
    results['(relatório ilegível)'] = { status: 'unknown', error: (r.stderr ?? '').slice(-500) }
  }
  return results
}

const wanted = process.argv.slice(2)
const summary = []
for (const m of MUTANTS.filter((x) => wanted.length === 0 || wanted.includes(x.id))) {
  const real = join(ROOT, m.file)
  const before = sha(real)
  const source = readFileSync(real, 'utf8')
  const hits = source.split(m.find).length - 1
  if (hits !== 1) {
    summary.push({ id: m.id, bug: m.bug, resultado: `NÃO APLICADO: trecho aparece ${hits}x em ${m.file}` })
    continue
  }
  const dir = join(OUT, `mut-${m.id}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true })
  for (const f of ['electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json']) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(dir, f))
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  pkg.name = `kora-e2e-${m.id.toLowerCase()}`
  pkg.productName = `Kora ADE E2E ${m.id}`
  delete pkg.scripts
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  writeFileSync(join(dir, m.file), source.replace(m.find, m.replace))

  const t0 = Date.now()
  const b = build(dir)
  if (!b.ok) {
    summary.push({ id: m.id, bug: m.bug, resultado: 'BUILD FALHOU', log: b.log.slice(-800) })
    continue
  }
  const results = runTests(dir, m.grep)
  const after = sha(real)
  const expected = m.expect ?? { [m.grep]: 'failed' }
  const verdicts = Object.entries(results).map(([title, r]) => {
    const key = Object.keys(expected).find((k) => title.startsWith(k))
    const want = key ? expected[key] : 'failed'
    return { title, status: r.status, esperado: want, ok: r.status === want, erro: r.error }
  })
  summary.push({
    id: m.id,
    arquivo: m.file,
    bug: m.bug,
    srcRealIntacto: before === after,
    segundos: Math.round((Date.now() - t0) / 1000),
    testes: verdicts,
    resultado: verdicts.length > 0 && verdicts.every((v) => v.ok) ? 'PEGO' : 'NÃO PEGO'
  })
  console.log(JSON.stringify(summary.at(-1), null, 2))
}
writeFileSync(join(OUT, 'mutantes.json'), JSON.stringify(summary, null, 2))
console.log('\n=== RESUMO ===')
for (const s of summary) console.log(`${s.id} ${s.resultado} — ${s.bug}${s.srcRealIntacto === false ? ' (ATENÇÃO: src real mudou durante o teste)' : ''}`)
