import { existsSync, statSync } from 'node:fs'
import * as pty from 'node-pty'
import { startupCommand, type Startup } from '../shared/agent'

// Se o Kora for aberto de dentro de outro agente ou do electron-vite, o shell herdaria esses
// marcadores: NO_COLOR apaga as cores e CLAUDE_CODE_CHILD_SESSION faz o Claude não salvar a sessão.
const INHERITED_MARKERS = [/^CLAUDE_CODE_/, /^CLAUDECODE$/, /^CLAUDE_PID$/, /^CODEX_/, /^ELECTRON_/, /^NO_COLOR$/, /^FORCE_COLOR$/]

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
  onData(id: string, data: string): void
  onExit(id: string, exitCode: number, pid: number): void
  // Logo depois do spawn: é aqui que o shell entra no Job Object, antes de abrir o Claude/Codex.
  onSpawn?(id: string, pid: number): void
}

export class Terminals {
  private readonly sessions = new Map<string, pty.IPty>()

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
      env: terminalEnv(process.env)
    })
    this.sessions.set(id, proc)
    this.events.onSpawn?.(id, proc.pid)
    proc.onData((data) => this.events.onData(id, data))
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      this.events.onExit(id, exitCode, proc.pid)
    })
  }

  pids(): Map<string, number> {
    return new Map([...this.sessions].map(([id, proc]) => [id, proc.pid]))
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(id)?.resize(cols, rows)
  }

  kill(id: string): void {
    this.sessions.get(id)?.kill()
    this.sessions.delete(id)
  }

  killAll(): void {
    for (const id of this.sessions.keys()) this.kill(id)
  }
}
