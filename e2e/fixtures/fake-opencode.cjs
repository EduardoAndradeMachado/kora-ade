'use strict'
// Imita o que o Kora observa do OpenCode v2: a conversa mora em ~/.local/share/opencode/opencode.db
// (session_v2 + session_message) e o turno termina com uma mensagem "idle".
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { log, registerPid, setTitle, onLines } = require('./fake-common.cjs')

const args = process.argv.slice(2)
const sessionAt = args.indexOf('--session')
const sessionArg = sessionAt >= 0 ? args[sessionAt + 1] : null
const sessionId = sessionArg && /^ses/i.test(sessionArg) ? sessionArg : `ses_${randomUUID().replace(/-/g, '')}`
const cwd = process.cwd()
const home = process.env.USERPROFILE
const short = sessionId.replace(/^ses_/, '').slice(0, 8)

registerPid('opencode')
log('opencode', 'start', { args, sessionId })
setTitle(`OC | OpenCode falso ${short}`)
process.stdout.write(`FAKE_OPENCODE session=${sessionId} args=${args.join(' ')}\r\n> `)

const dir = join(home, '.local', 'share', 'opencode')
mkdirSync(dir, { recursive: true })
const db = new DatabaseSync(join(dir, 'opencode.db'))
db.exec(`
  pragma journal_mode = wal;
  create table if not exists session_v2 (
    id text primary key,
    title text,
    time_updated integer not null,
    directory text not null,
    parent_id text,
    time_archived integer
  );
  create table if not exists session_message (
    id text primary key,
    session_id text not null,
    type text not null,
    seq integer not null,
    time_created integer not null,
    time_updated integer not null,
    data text not null
  );
`)

const now = () => Date.now()
db.prepare(
  'insert or ignore into session_v2 (id, title, time_updated, directory, parent_id, time_archived) values (?, ?, ?, ?, ?, ?)'
).run(sessionId, `OpenCode falso ${short}`, now(), cwd.replace(/\\/g, '/'), null, null)
db.prepare('update session_v2 set title = ?, time_updated = ? where id = ?').run(
  `OpenCode falso ${short}`,
  now(),
  sessionId
)

const startSeq = db.prepare('select coalesce(max(seq), 0) as n from session_message where session_id = ?').get(sessionId)
let seq = Number(startSeq.n)
function add(type, data) {
  seq += 1
  const at = now()
  db.prepare(
    'insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)'
  ).run(`msg_${sessionId}_${seq}`, sessionId, type, seq, at, at, JSON.stringify(data))
  db.prepare('update session_v2 set time_updated = ? where id = ?').run(at, sessionId)
  log('opencode', 'message', { sessionId, type, seq })
}

onLines(
  (line) => {
    log('opencode', 'input', { sessionId, line })
    if (line.trim() === '/exit') {
      db.close()
      log('opencode', 'exit', { sessionId })
      process.exit(0)
    }
    const timed = /^trabalhe (\d+)$/.exec(line.trim())
    if (timed) {
      add('user', {})
      setTimeout(() => {
        add('assistant', { time: { created: now(), completed: now() }, finish: 'stop' })
        add('idle', {})
      }, Number(timed[1]) * 1000)
    }
    process.stdout.write(`eco: ${line}\r\n> `)
  },
  () => log('opencode', 'stdin-end', { sessionId })
)
setInterval(() => {}, 60_000)
