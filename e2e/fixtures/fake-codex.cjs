'use strict'
// Imita o que o Kora observa do Codex: o lock ~/.codex/thread-writer-locks/<uuid>.lock fica aberto
// por este processo a partir da primeira mensagem, e o rollout + session_index registram a conversa.
const { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { UUID, log, registerPid, setTitle, onLines } = require('./fake-common.cjs')

const args = process.argv.slice(2)
const resumeAt = args.indexOf('resume')
const resumed = resumeAt >= 0 && UUID.test(args[resumeAt + 1] ?? '') ? args[resumeAt + 1] : null
const home = process.env.USERPROFILE
const cwd = process.cwd()
let threadId = null
let lockFd = null

registerPid('codex')
log('codex', 'start', { args, resumed })
setTitle('FakeCodex')
process.stdout.write(`FAKE_CODEX args=${args.join(' ')}\r\n> `)

function startThread() {
  threadId = resumed ?? randomUUID()
  const locks = join(home, '.codex', 'thread-writer-locks')
  mkdirSync(locks, { recursive: true })
  lockFd = openSync(join(locks, `${threadId}.lock`), 'w')
  const day = join(home, '.codex', 'sessions', '2026', '09', '24')
  mkdirSync(day, { recursive: true })
  const rollout = join(day, `rollout-2026-09-24T10-00-00-${threadId}.jsonl`)
  writeFileSync(
    rollout,
    JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd, originator: 'codex-tui' } }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pedido codex' }] }
      }) +
      '\n',
    'utf8'
  )
  appendFileSync(
    join(home, '.codex', 'session_index.jsonl'),
    JSON.stringify({ id: threadId, thread_name: `Codex falso ${threadId.slice(0, 8)}`, updated_at: new Date().toISOString() }) +
      '\n',
    'utf8'
  )
  log('codex', 'lock', { threadId })
}

onLines(
  (line) => {
    if (!threadId) startThread()
    log('codex', 'input', { threadId, line })
    if (line.trim() === '/exit') {
      if (lockFd !== null) closeSync(lockFd)
      log('codex', 'exit', { threadId })
      process.exit(0)
    }
    process.stdout.write(`eco: ${line}\r\n> `)
  },
  () => log('codex', 'stdin-end', { threadId })
)
setInterval(() => {}, 60_000)
