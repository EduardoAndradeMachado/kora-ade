import { existsSync, statSync } from 'node:fs'
import * as pty from 'node-pty'
import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { startupCommand, type AgentKind, type Startup } from '../shared/agent'
import type { TerminalSnapshot } from '../shared/mobile'

// Se o Kora for aberto de dentro de outro agente ou do electron-vite, o shell herdaria esses
// marcadores: NO_COLOR apaga as cores, CLAUDE_CODE_CHILD_SESSION faz o Claude não salvar a sessão
// e os marcadores do OpenCode fazem a CLI se achar dentro de outra sessão/terminal.
const INHERITED_MARKERS = [
  /^CLAUDE_CODE_/,
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CODEX_/,
  /^ELECTRON_/,
  /^NO_COLOR$/,
  /^FORCE_COLOR$/,
  /^OPENCODE$/,
  /^OPENCODE_SESSION_ID$/,
  /^OPENCODE_TERMINAL$/
]

export function terminalEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || INHERITED_MARKERS.some((re) => re.test(key))) continue
    env[key] = value
  }
  // CLIs como Claude/Codex decidem cor, links clicáveis e UTF-8 olhando essas variáveis.
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'kora'
  env['FORCE_HYPERLINK'] = '1'
  env['LANG'] ??= 'en_US.UTF-8'
  env['PYTHONUTF8'] ??= '1'
  return env
}

export interface TerminalEvents {
  onData(id: string, data: string, sequence: number): void
  onExit(id: string, exitCode: number, pid: number): void
  // Logo depois do spawn: é aqui que o shell entra no Job Object, antes de abrir o Claude/Codex.
  onSpawn?(id: string, pid: number): void
}

// Cópia da tela no main, para o celular abrir a aba já no estado atual. Só existe com a conexão do celular
// ligada: interpretar toda a saída custa CPU no processo principal.
interface Mirror {
  proc: pty.IPty
  terminal: Terminal
  serialize: SerializeAddon
  sequence: number
  pending: Set<(snapshot: TerminalSnapshot | null) => void>
}

// O Claude Code trata o Enter que chega colado no fim do texto como parte dele; separado, envia a mensagem.
// O Codex é mais desconfiado: Enter logo depois de uma rajada de caracteres vira quebra de linha (é a proteção
// dele contra colagem), e com 60 ms a mensagem do celular só pulava linha.
const SUBMIT_DELAY_MS = 60
const CODEX_SUBMIT_DELAY_MS = 400
// Tempo para o agente ler o arquivo colado e trocar o caminho por [Image #n] antes da próxima colagem.
const IMAGE_PASTE_GAP_MS = 250

export class Terminals {
  private readonly sessions = new Map<string, pty.IPty>()
  private readonly mirrors = new Map<string, Mirror>()
  private mirroring = false
  private sequence = 0

  constructor(
    private readonly events: TerminalEvents,
    private readonly shell = 'powershell.exe',
    private readonly shellArgs: string[] = ['-NoLogo']
  ) {}

  spawn(id: string, cwd: string, cols: number, rows: number, startup?: Startup): void {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Pasta do projeto não existe: ${cwd}`)
    }
    if (this.sessions.has(id)) throw new Error(`Terminal já está aberto: ${id}`)
    // -NoExit: quando o Claude/Codex sair, a aba continua como um PowerShell normal na pasta.
    const args = startup ? [...this.shellArgs, '-NoExit', '-Command', startupCommand(startup)] : this.shellArgs
    const proc = pty.spawn(this.shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // O ConPTY do sistema engole a consulta de cor de fundo usada pelos destaques do Codex.
      useConptyDll: process.platform === 'win32' && startup?.kind === 'codex',
      env: terminalEnv(process.env)
    })
    this.sessions.set(id, proc)
    if (this.mirroring) this.mirror(id, proc, cols, rows)
    this.events.onSpawn?.(id, proc.pid)
    proc.onData((data) => {
      const sequence = ++this.sequence
      const mirror = this.mirrors.get(id)
      if (mirror?.proc === proc) mirror.terminal.write(data, () => (mirror.sequence = sequence))
      this.events.onData(id, data, sequence)
    })
    proc.onExit(({ exitCode }) => {
      // Aba suspensa e reaberta logo em seguida: a saída do processo antigo não pode levar o novo junto.
      if (this.sessions.get(id) === proc) this.sessions.delete(id)
      if (this.mirrors.get(id)?.proc === proc) this.dropMirror(id)
      this.events.onExit(id, exitCode, proc.pid)
    })
  }

  setMirroring(on: boolean): void {
    this.mirroring = on
    if (!on) for (const id of this.mirrors.keys()) this.dropMirror(id)
    else for (const [id, proc] of this.sessions) if (!this.mirrors.has(id)) this.mirror(id, proc, proc.cols, proc.rows)
  }

  private mirror(id: string, proc: pty.IPty, cols: number, rows: number): void {
    const terminal = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true, windowsPty: { backend: 'conpty' } })
    const serialize = new SerializeAddon()
    terminal.loadAddon(serialize as unknown as ITerminalAddon)
    // A janela do PC e a do celular contam emoji como duas colunas (Unicode 11). Contando uma, o "vá para a
    // coluna X" que o ConPTY manda depois de um emoji cai antes do lugar, e a foto do celular sai sem ele.
    terminal.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon)
    terminal.unicode.activeVersion = '11'
    this.mirrors.set(id, { proc, terminal, serialize, sequence: this.sequence, pending: new Set() })
  }

  private dropMirror(id: string): void {
    const mirror = this.mirrors.get(id)
    if (!mirror) return
    this.mirrors.delete(id)
    for (const resolve of mirror.pending) resolve(null)
    mirror.terminal.dispose()
  }

  // O write vazio espera o xterm terminar de interpretar o que já chegou: a foto e a sequência batem.
  snapshot(id: string): Promise<TerminalSnapshot | null> {
    const mirror = this.mirrors.get(id)
    if (!mirror) return Promise.resolve(null)
    return new Promise((resolve) => {
      mirror.pending.add(resolve)
      mirror.terminal.write('', () => {
        if (!mirror.pending.delete(resolve)) return
        const { terminal } = mirror
        resolve({ data: mirror.serialize.serialize(), sequence: mirror.sequence, cols: terminal.cols, rows: terminal.rows })
      })
    })
  }

  // Texto digitado no celular: vai como colagem quando o programa aceita, para quebras de linha não enviarem antes.
  // O Claude e o Codex só anexam uma imagem quando o caminho chega sozinho numa colagem, como no Ctrl+V do PC;
  // junto com o texto ele fica como texto. Então cada imagem é uma colagem, com pausa para virar anexo.
  submit(id: string, text: string, agent?: AgentKind, images: string[] = []): void {
    const proc = this.sessions.get(id)
    if (!proc) throw new Error('A sessão está suspensa.')
    const bracketed = this.mirrors.get(id)?.terminal.modes.bracketedPasteMode ?? false
    const pastes = bracketed
      ? [...images, text].filter(Boolean).map((part) => `\x1b[200~${part}\x1b[201~`)
      : [[...images, text].filter(Boolean).join(' ').replace(/\r?\n/g, '\r')]
    pastes.forEach((paste, index) => setTimeout(() => {
      if (this.sessions.get(id) === proc) proc.write(paste)
    }, index * IMAGE_PASTE_GAP_MS))
    setTimeout(() => {
      if (this.sessions.get(id) === proc) proc.write('\r')
    }, (pastes.length - 1) * IMAGE_PASTE_GAP_MS + (agent === 'codex' ? CODEX_SUBMIT_DELAY_MS : SUBMIT_DELAY_MS))
  }

  pids(): Map<string, number> {
    return new Map([...this.sessions].map(([id, proc]) => [id, proc.pid]))
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    this.sessions.get(id)?.resize(cols, rows)
    this.mirrors.get(id)?.terminal.resize(cols, rows)
  }

  kill(id: string): void {
    this.sessions.get(id)?.kill()
    this.sessions.delete(id)
    this.dropMirror(id)
  }

  killAll(): void {
    for (const id of this.sessions.keys()) this.kill(id)
  }
}
