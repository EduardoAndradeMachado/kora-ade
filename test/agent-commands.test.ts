import { describe, expect, it } from 'vitest'
import { agentCommands } from '../src/shared/agent-commands'
import menus from './fixtures/agent-menus.json'

// O menu "/" que cada agente mostra no terminal dele (fixture lida das telas reais). O celular não pode oferecer a um
// agente comando que ele não tem, como /approvals no Codex ou /compact no agy.
describe('menu "/" do celular por agente', () => {
  for (const kind of ['claude', 'codex', 'opencode', 'antigravity'] as const) {
    it(`${kind}: todo comando oferecido existe no menu do próprio agente`, () => {
      const real = new Set(menus[kind])
      const offered = agentCommands(kind).map((command) => command.name)
      expect(offered.length).toBeGreaterThan(0)
      expect(offered.filter((name) => !real.has(name))).toEqual([])
    })
  }
})
