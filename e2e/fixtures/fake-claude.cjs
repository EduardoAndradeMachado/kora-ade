'use strict'
// Imita o que o Kora observa do Claude Code: ~/.claude/sessions/<pid>.json enquanto roda e o
// histórico em ~/.claude/projects/<cwd sanitizado>/<uuid>.jsonl. Não fala com nenhuma API.
const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { UUID, log, registerPid, setTitle, onLines } = require('./fake-common.cjs')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && UUID.test(args[i + 1] ?? '') ? args[i + 1] : null
}
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID()
const home = process.env.USERPROFILE
const cwd = process.cwd()
const short = sessionId.slice(0, 8)

const sessionsDir = join(home, '.claude', 'sessions')
mkdirSync(sessionsDir, { recursive: true })
const pidFile = join(sessionsDir, `${process.pid}.json`)
// O Claude real troca o status desse arquivo conforme a tela: busy respondendo, idle parado no prompt.
const writeStatus = (status) =>
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, sessionId, cwd, name: `fake-${short}`, status }), 'utf8')
writeStatus('idle')

const projectDir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(projectDir, { recursive: true })
const history = join(projectDir, `${sessionId}.jsonl`)
appendFileSync(
  history,
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'pedido de teste' }, isSidechain: false }) +
    '\n' +
    JSON.stringify({ type: 'ai-title', aiTitle: `Título falso ${short}`, sessionId }) +
    '\n',
  'utf8'
)

registerPid('claude')
log('claude', 'start', { args, sessionId })
setTitle(`FakeClaude ${short}`)
process.stdout.write(`FAKE_CLAUDE session=${sessionId} args=${args.join(' ')}\r\n> `)

const cleanup = () => rmSync(pidFile, { force: true })
// O Claude real troca o título do terminal enquanto trabalha; isso testa se o nome dado pelo usuário resiste.
let turns = 0
onLines(
  (line, pasted) => {
    log('claude', 'input', { sessionId, line, pasted })
    if (line.trim() === '/exit') {
      cleanup()
      log('claude', 'exit', { sessionId })
      process.exit(0)
    }
    if (line.trim() === 'trabalhe') writeStatus('busy')
    if (line.trim() === 'pare') writeStatus('idle')
    // "trabalhe 5": turno de 5 s que termina sozinho, como um turno que acaba enquanto você está em outra aba.
    // "trabalhe-bg 5": igual, mas termina deixando um comando em segundo plano aberto; o Claude real grava "shell"
    // nesse caso (parado no prompt, com tarefa local_bash ainda rodando), não "idle". O arquivo é reescrito algumas
    // vezes durante o turno, como o real faz ao atualizar o status.
    const timed = /^trabalhe(-bg)? (\d+)$/.exec(line.trim())
    if (timed) {
      const until = Date.now() + Number(timed[2]) * 1000
      const endStatus = timed[1] ? 'shell' : 'idle'
      writeStatus('busy')
      const tick = setInterval(() => {
        if (Date.now() < until) return writeStatus('busy')
        clearInterval(tick)
        writeStatus(endStatus)
      }, 700)
    }
    turns++
    setTitle(`FakeClaude ${short} turno ${turns}`)
    process.stdout.write(`eco: ${line}\r\n> `)
  },
  () => log('claude', 'stdin-end', { sessionId })
)
setInterval(() => {}, 60_000)
