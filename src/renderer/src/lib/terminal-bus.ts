import { TerminalBus } from '@shared/terminal-bus'

export const terminalBus = new TerminalBus()

window.kora.onTerminalData((id, data) => terminalBus.push(id, data))
