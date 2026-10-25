import { TerminalBus } from '@shared/terminal-bus'

export const terminalBus = new TerminalBus()

window.kora.onTerminalData((id, data, sequence) => terminalBus.push(id, data, sequence))
