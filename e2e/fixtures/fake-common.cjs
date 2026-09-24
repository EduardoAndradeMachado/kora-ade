'use strict'
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function log(agent, event, data) {
  const file = process.env.KORA_FAKE_LOG
  if (!file) return
  const entry = { t: Date.now(), agent, event, pid: process.pid, ppid: process.ppid, cwd: process.cwd(), ...data }
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
}

// A suíte só mata processos que ela mesma criou: cada agente falso se registra aqui.
function registerPid(agent) {
  const dir = process.env.KORA_FAKE_PIDS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, agent }), 'utf8')
}

// ESC, CSI, OSC e o marcador de colagem (bracketed paste) não interessam ao log.
function stripControl(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

function setTitle(title) {
  process.stdout.write(`\x1b]0;${title}\x07`)
}

// Lê a entrada crua do console e entrega linha a linha, sem depender do modo cozido do ConPTY.
function onLines(handler, onClose) {
  let buffer = ''
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    for (const ch of chunk) {
      if (ch === '\r' || ch === '\n') {
        const line = stripControl(buffer)
        buffer = ''
        process.stdout.write('\r\n')
        handler(line)
      } else if (ch === '\x03') {
        handler('\x03')
      } else if (ch === '\x7f' || ch === '\b') {
        buffer = buffer.slice(0, -1)
      } else {
        buffer += ch
        process.stdout.write(ch)
      }
    }
  })
  process.stdin.on('end', () => onClose && onClose())
  process.stdin.resume()
}

module.exports = { UUID, log, registerPid, stripControl, setTitle, onLines }
