import { existsSync, statSync } from 'node:fs'
import * as pty from 'node-pty'
import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { startupCommand, type AgentKind, type Startup } from '../shared/agent'
import type { TerminalSnapshot } from '../shared/mobile'
import { terminateIfStillRunning } from './processes'
import { resolveInside } from './files'

// Pasta inicial do terminal aberto por "Abrir no terminal integrado" (relativa ao projeto). Ela pode ter sumido
// desde que a aba foi aberta; aí o terminal volta para a raiz do projeto em vez de a aba não abrir mais.
// Fora do projeto não abre: o caminho vem do renderer e do estado salvo.
export function terminalCwd(root: string, dir: string | undefined): string {
  if (!dir) return root
  const target = resolveInside(root, dir)
  return existsSync(target) && statSync(target).isDirectory() ? target : root
}

// Se o Kora for aberto de dentro de outro agente ou do electron-vite, o shell herdaria esses
// marcadores: NO_COLOR apaga as cores, CLAUDE_CODE_CHILD_SESSION faz o Claude não salvar a sessão
// e os marcadores do OpenCode e do agy fazem a CLI se achar dentro de outra sessão/terminal.
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
  /^OPENCODE_TERMINAL$/,
  /^ANTIGRAVITY_/
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

// Cópia da tela no main, de todo terminal: é dela que a interface recarregada depois de uma queda e o celular
// tiram a tela atual. Custa a memória de mais um buffer de histórico por aba, no processo principal.
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
const SHELL_EXIT_GRACE_MS = 3000
// Tempo na altura uma linha menor: o bastante para o ConPTY avisar o programa da mudança antes de voltar.
const REDRAW_NUDGE_MS = 150

interface KittyKeyboardState {
  flags: number
  mainFlags: number
  altFlags: number
  mainStack: number[]
  altStack: number[]
}

// A API pública do xterm não expõe as flags do protocolo de teclado kitty (o próprio SerializeAddon lê o _core
// para a região de rolagem). Formato diferente numa versão nova do xterm: sem flags, e o teste de reconexão acusa.
function kittyKeyboardState(terminal: Terminal): KittyKeyboardState | null {
  const state = (terminal as unknown as { _core?: { coreService?: { kittyKeyboard?: Partial<KittyKeyboardState> } } })._core
    ?.coreService?.kittyKeyboard
  const isFlags = (value: unknown): value is number => typeof value === 'number'
  const isStack = (value: unknown): value is number[] => Array.isArray(value) && value.every(isFlags)
  if (!state || !isFlags(state.flags) || !isFlags(state.mainFlags) || !isFlags(state.altFlags)) return null
  if (!isStack(state.mainStack) || !isStack(state.altStack)) return null
  return state as KittyKeyboardState
}

// Empilhar guarda as flags atuais e liga as novas: começa pela base da pilha e termina nas atuais.
function rebuildFlags(stack: number[], current: number): string {
  const [base, ...rest] = [...stack, current]
  return `\x1b[=${base};1u${rest.map((flags) => `\x1b[>${flags}u`).join('')}`
}

// O SerializeAddon não leva as flags do teclado kitty. Sem elas a janela reconectada volta com flags 0 e o
// Shift+Enter do Claude Code passa a enviar a mensagem. Cada tela (normal e alternativa) tem flags e pilha
// próprias: a alternativa é montada entrando e saindo dela no terminal ainda vazio, e a troca de tela que a foto
// traz depois (quando a alternativa está ativa) é que a reativa.
function keyboardPrelude(terminal: Terminal): string {
  const state = kittyKeyboardState(terminal)
  if (!state) return ''
  const onAlt = terminal.buffer.active.type === 'alternate'
  const main = { stack: state.mainStack, current: onAlt ? state.mainFlags : state.flags }
  const alt = { stack: state.altStack, current: onAlt ? state.flags : state.altFlags }
  let prelude = ''
  if (alt.current || alt.stack.length) prelude += `\x1b[?1049h${rebuildFlags(alt.stack, alt.current)}\x1b[?1049l`
  if (main.current || main.stack.length) prelude += rebuildFlags(main.stack, main.current)
  return prelude
}

export class Terminals {
  private readonly sessions = new Map<string, pty.IPty>()
  private readonly mirrors = new Map<string, Mirror>()
  private sequence = 0
  private readonly sizes = new Map<string, { cols: number; rows: number }>()

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
    this.sizes.set(id, { cols, rows })
    this.mirror(id, proc, cols, rows)
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

  private mirror(id: string, proc: pty.IPty, cols: number, rows: number): void {
    // Mesmo histórico e mesmo protocolo de teclado da janela (TerminalView): a tela reconstruída é a que ela tinha.
    const terminal = new Terminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true,
      windowsPty: { backend: 'conpty' },
      vtExtensions: { kittyKeyboard: true }
    })
    const serialize = new SerializeAddon()
    terminal.loadAddon(serialize as unknown as ITerminalAddon)
    // A janela do PC e a do celular contam emoji como duas colunas (Unicode 11). Contando uma, o "vá para a
    // coluna X" que o ConPTY manda depois de um emoji cai antes do lugar, e a foto do celular sai sem ele.
    terminal.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon)
    terminal.unicode.activeVersion = '11'
    this.mirrors.set(id, { proc, terminal, serialize, sequence: this.sequence, pending: new Set() })
  }

  private dropMirror(id: string): void {
    this.sizes.delete(id)
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
        const data = keyboardPrelude(terminal) + mirror.serialize.serialize()
        resolve({ data, sequence: mirror.sequence, cols: terminal.cols, rows: terminal.rows })
      })
    })
  }

  // Texto digitado no celular: vai como colagem quando o programa aceita, para quebras de linha não enviarem antes.
  // O Claude e o Codex só anexam uma imagem quando o caminho chega sozinho numa colagem, como no Ctrl+V do PC;
  // junto com o texto ele fica como texto. Então cada imagem é uma colagem, com pausa para virar anexo.
  // Arquivo que não é imagem não vira anexo: o caminho vai no fim do texto e o agente lê o arquivo por ele.
  submit(id: string, text: string, agent?: AgentKind, images: string[] = [], files: string[] = []): void {
    const proc = this.sessions.get(id)
    if (!proc) throw new Error('A sessão está suspensa.')
    const bracketed = this.mirrors.get(id)?.terminal.modes.bracketedPasteMode ?? false
    const typed = text.trim() === '' ? '' : text
    // Só arquivo, no agente: a linha não começa pelo caminho. Se o agente saiu e sobrou o PowerShell da aba, o Enter
    // roda "Anexo:", que não existe, e não o arquivo (um .cmd vindo do celular).
    const lead = typed === '' && agent && files.length > 0 ? 'Anexo:' : typed
    const message = [lead, ...files.map((file) => (file.includes(' ') ? `"${file}"` : file))].filter(Boolean).join(' ')
    // O texto vem primeiro, como quem digita e depois dá Ctrl+V no print: a linha nunca começa pelo caminho, que o
    // shell executaria (o PowerShell abria o app de Fotos). No agente, cada caminho numa colagem vira anexo.
    const pastes = bracketed && agent
      ? [message, ...images].filter(Boolean).map((part) => `\x1b[200~${part}\x1b[201~`)
      : [[message, ...images].filter(Boolean).join(' ')].map((line) => (bracketed ? `\x1b[200~${line}\x1b[201~` : line.replace(/\r?\n/g, '\r')))
    pastes.forEach((paste, index) => setTimeout(() => {
      if (this.sessions.get(id) === proc) proc.write(paste)
    }, index * IMAGE_PASTE_GAP_MS))
    // Num terminal comum, só imagem não aperta Enter, para não executar o arquivo. Com arquivo, também não: o nome
    // vem do celular e o shell expandiria $(...), ; e & dele.
    if (!agent && (typed === '' || files.length > 0)) return
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
    this.sizes.set(id, { cols, rows })
    this.resizeNow(id, cols, rows)
  }

  // Reabrir no mesmo tamanho não muda nada no pty, e a tela embaralhada continua. Mudar a altura em uma linha e
  // voltar faz o Claude, o Codex e o OpenCode redesenharem a tela inteira. A volta usa o último tamanho pedido, para
  // não desfazer uma troca de dono que chegue no meio.
  redraw(id: string): void {
    const proc = this.sessions.get(id)
    const mirror = this.mirrors.get(id)
    if (!proc || !mirror) return
    const { cols, rows } = mirror.terminal
    this.resizeNow(id, cols, rows > 1 ? rows - 1 : rows + 1)
    setTimeout(() => {
      if (this.sessions.get(id) !== proc) return
      const size = this.sizes.get(id) ?? { cols, rows }
      this.resizeNow(id, size.cols, size.rows)
    }, REDRAW_NUDGE_MS)
  }

  private resizeNow(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows)
    this.mirrors.get(id)?.terminal.resize(cols, rows)
  }

  kill(id: string): void {
    const proc = this.sessions.get(id)
    proc?.kill()
    // O kill do node-pty só fecha o pseudoconsole: o shell sai com o aviso de fechamento, mas um PowerShell ainda
    // subindo, com a máquina carregada, pode passar do prazo e ficar órfão.
    if (proc) terminateIfStillRunning(proc.pid, SHELL_EXIT_GRACE_MS)
    this.sessions.delete(id)
    this.dropMirror(id)
  }

  killAll(): void {
    for (const id of this.sessions.keys()) this.kill(id)
  }
}
