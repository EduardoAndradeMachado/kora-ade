import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  claudeProjectDir,
  listClaudeSessions,
  listCodexSessions,
  listProjectSessions,
  sessionArtifacts
} from '../src/main/sessions'

let claudeRoot: string
let codexRoot: string
const project = 'C:\\Users\\voce\\Documents\\Github\\meu_projeto.web'

const jsonl = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
// Linhas no formato real do Claude Code 2.1.281.
const userLine = (content: unknown, extra: object = {}): object => ({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content },
  cwd: project,
  ...extra
})

function writeClaude(sessionId: string, body: string, mtime?: Date): void {
  const dir = claudeProjectDir(claudeRoot, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, body, 'utf8')
  if (mtime) utimesSync(file, mtime, mtime)
}

function writeCodex(
  sessionId: string,
  cwd: string,
  mtime?: Date,
  padding = 0,
  opts: { meta?: object; userTexts?: string[]; day?: string } = {}
): string {
  const day = opts.day ?? '24'
  const dir = join(codexRoot, 'sessions', '2026', '09', day)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-09-${day}T09-51-33-${sessionId}.jsonl`)
  // A primeira linha real tem ~22 KB (instruções embutidas); o cwd vem depois de muito texto.
  const meta = {
    type: 'session_meta',
    payload: { id: sessionId, base: 'x'.repeat(padding), cwd, originator: 'codex-tui', ...opts.meta }
  }
  const users = (opts.userTexts ?? ['pedido']).map((text) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  }))
  writeFileSync(file, jsonl(meta, { type: 'event_msg', payload: { type: 'task_started' } }, ...users), 'utf8')
  if (mtime) utimesSync(file, mtime, mtime)
  return file
}

beforeEach(() => {
  claudeRoot = mkdtempSync(join(tmpdir(), 'kora-claude-root-'))
  codexRoot = mkdtempSync(join(tmpdir(), 'kora-codex-root-'))
})

describe('pasta do projeto no Claude', () => {
  it('troca todo caractere não alfanumérico por hífen, como o Claude Code', async () => {
    expect(claudeProjectDir('R', 'C:\\Users\\voce\\Documents\\Github\\app-exemplo\\.claude\\worktrees\\x_y')).toBe(
      join('R', 'projects', 'C--Users-voce-Documents-Github-app-exemplo--claude-worktrees-x-y')
    )
  })
})

describe('sessões do Claude', () => {
  it('título: /rename vence o título gerado, que vence a primeira mensagem', async () => {
    const a = randomUUID()
    const b = randomUUID()
    const c = randomUUID()
    writeClaude(
      a,
      jsonl(
        userLine('primeira mensagem de a'),
        { type: 'ai-title', aiTitle: 'Título gerado', sessionId: a },
        { type: 'custom-title', customTitle: 'bruteforce', sessionId: a },
        { type: 'ai-title', aiTitle: 'Título gerado depois', sessionId: a }
      )
    )
    writeClaude(b, jsonl(userLine('oi'), { type: 'ai-title', aiTitle: 'Seleção de modelos', sessionId: b }))
    writeClaude(c, jsonl(userLine([{ type: 'text', text: 'Corrigir o login do painel' }])))

    const byId = new Map((await listClaudeSessions(claudeRoot, project)).map((s) => [s.sessionId, s.title]))

    expect(byId.get(a)).toBe('bruteforce')
    expect(byId.get(b)).toBe('Seleção de modelos')
    expect(byId.get(c)).toBe('Corrigir o login do painel')
  })

  it('mensagem injetada com tags não vira título; sessão sem mensagem nenhuma não aparece', async () => {
    const withTags = randomUUID()
    const empty = randomUUID()
    writeClaude(
      withTags,
      jsonl(userLine('<command-name>/clear</command-name>'), userLine('Revisar o deploy de amanhã'))
    )
    writeClaude(empty, jsonl({ type: 'permission-mode', mode: 'bypass' }))

    const sessions = await listClaudeSessions(claudeRoot, project)

    expect(sessions.map((s) => s.sessionId)).toEqual([withTags])
    expect(sessions[0]!.title).toBe('Revisar o deploy de amanhã')
  })

  it('ignora mensagens de subagente (sidechain) ao escolher o título', async () => {
    const id = randomUUID()
    writeClaude(id, jsonl(userLine('tarefa interna do subagente', { isSidechain: true }), userLine('Pedido real')))
    expect((await listClaudeSessions(claudeRoot, project))[0]!.title).toBe('Pedido real')
  })

  it('não mistura sessões de outro projeto', async () => {
    const outra = claudeProjectDir(claudeRoot, 'C:\\outro')
    mkdirSync(outra, { recursive: true })
    writeFileSync(join(outra, `${randomUUID()}.jsonl`), jsonl(userLine('de outro projeto')))
    expect(await listClaudeSessions(claudeRoot, project)).toEqual([])
  })
})

describe('sessões do Codex', () => {
  it('lista só as conversas cujo cwd é o projeto, mesmo com o cwd longe do início da linha', async () => {
    const minha = randomUUID()
    const deOutro = randomUUID()
    writeCodex(minha, project.toUpperCase(), undefined, 20_000)
    writeCodex(deOutro, 'C:\\outro')

    expect((await listCodexSessions(codexRoot, project)).map((s) => s.sessionId)).toEqual([minha])
  })

  it('título vem do session_index; vale a última entrada da conversa', async () => {
    const id = randomUUID()
    writeCodex(id, project)
    writeFileSync(
      join(codexRoot, 'session_index.jsonl'),
      jsonl(
        { id, thread_name: 'Nome antigo', updated_at: '2026-09-24T02:37:16.5782365Z' },
        { id, thread_name: 'Responder com kiwi', updated_at: '2026-09-24T12:51:45.6286602Z' }
      )
    )
    expect((await listCodexSessions(codexRoot, project))[0]!.title).toBe('Responder com kiwi')
  })
})

describe('Codex: subagentes e títulos de reserva', () => {
  it('thread de subagente não aparece como conversa retomável', async () => {
    const principal = randomUUID()
    const sub = randomUUID()
    writeCodex(principal, project)
    writeCodex(sub, project, undefined, 0, {
      meta: { parent_thread_id: principal, source: { subagent: { thread_spawn: {} } }, agent_nickname: 'Descartes' }
    })
    expect((await listCodexSessions(codexRoot, project)).map((s) => s.sessionId)).toEqual([principal])
  })

  it('sem entrada no índice, o título é o primeiro pedido real (pula AGENTS.md e contexto injetado)', async () => {
    const id = randomUUID()
    writeCodex(id, project, undefined, 0, {
      userTexts: [
        '# AGENTS.md instructions\n\n<INSTRUCTIONS>...',
        '<environment_context>...</environment_context>',
        'Roteirizar vídeo do projeto'
      ]
    })
    expect((await listCodexSessions(codexRoot, project))[0]!.title).toBe('Roteirizar vídeo do projeto')
  })

  it('conversa aberta e fechada sem pedido nenhum não aparece', async () => {
    writeCodex(randomUUID(), project, undefined, 0, { userTexts: ['# AGENTS.md instructions'] })
    expect(await listCodexSessions(codexRoot, project)).toEqual([])
  })
})

describe('leitura não trava o processo principal', () => {
  it('com centenas de conversas, timers continuam rodando durante a listagem', async () => {
    for (let i = 0; i < 300; i++) writeCodex(randomUUID(), i % 2 ? project : 'C:\\outro', undefined, 20_000)

    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    await listProjectSessions(claudeRoot, codexRoot, project)
    clearInterval(timer)

    // Leitura síncrona (mesmo embrulhada em async) só devolveria a vez no fim: nenhum tick no meio.
    expect(ticks).toBeGreaterThan(0)
  })
})

describe('lista do projeto', () => {
  it('junta Claude e Codex, mais recente primeiro', async () => {
    const velha = randomUUID()
    const nova = randomUUID()
    writeClaude(velha, jsonl(userLine('velha')), new Date('2026-09-20T10:00:00Z'))
    writeCodex(nova, project, new Date('2026-09-24T10:00:00Z'))

    expect((await listProjectSessions(claudeRoot, codexRoot, project)).map((s) => [s.kind, s.sessionId])).toEqual([
      ['codex', nova],
      ['claude', velha]
    ])
  })
})

describe('arquivos de uma sessão (para mandar à Lixeira)', () => {
  const roots = (): { claudeRoot: string; codexRoot: string } => ({ claudeRoot, codexRoot })
  const real = (path: string): string => realpathSync.native(path)
  // Junction não exige privilégio de administrador no Windows, ao contrário do link simbólico.
  const junction = (target: string, path: string): void => symlinkSync(target, path, 'junction')
  const transcript = (id: string): string => real(join(claudeProjectDir(claudeRoot, project), `${id}.jsonl`))

  describe('Claude', () => {
    it('devolve o .jsonl e a pasta irmã com subagentes e resultados de ferramenta', async () => {
      const id = randomUUID()
      writeClaude(id, jsonl(userLine('oi')))
      const extras = join(claudeProjectDir(claudeRoot, project), id)
      mkdirSync(join(extras, 'subagents'), { recursive: true })
      writeFileSync(join(extras, 'subagents', 'agent-1.jsonl'), '{}\n')

      expect(await sessionArtifacts('claude', id, project, roots())).toEqual([transcript(id), real(extras)])
    })

    it('sem pasta irmã, devolve só o .jsonl', async () => {
      const id = randomUUID()
      writeClaude(id, jsonl(userLine('oi')))
      expect(await sessionArtifacts('claude', id, project, roots())).toEqual([transcript(id)])
    })

    it('não pega a sessão com o mesmo id guardada em outro projeto', async () => {
      const id = randomUUID()
      writeClaude(randomUUID(), jsonl(userLine('outra conversa deste projeto')))
      const outro = claudeProjectDir(claudeRoot, 'C:\\outro')
      mkdirSync(join(outro, id), { recursive: true })
      writeFileSync(join(outro, `${id}.jsonl`), jsonl(userLine('de outro projeto')))

      expect(await sessionArtifacts('claude', id, project, roots())).toEqual([])
    })

    it('sessão inexistente devolve lista vazia', async () => {
      expect(await sessionArtifacts('claude', randomUUID(), project, roots())).toEqual([])
    })
  })

  describe('id inválido', () => {
    for (const kind of ['claude', 'codex'] as const) {
      for (const bad of ['../../x', 'abc', '', `${randomUUID()}/..`]) {
        it(`${kind}: ${JSON.stringify(bad)} lança erro`, async () => {
          await expect(sessionArtifacts(kind, bad, project, roots())).rejects.toThrow(/ID de sessão inválido/)
        })
      }
    }

    it('lança mesmo quando `../../x` alcançaria um arquivo existente', async () => {
      mkdirSync(join(claudeRoot, 'projects'), { recursive: true })
      writeFileSync(join(claudeRoot, 'x.jsonl'), '{}\n')
      await expect(sessionArtifacts('claude', '../../x', project, roots())).rejects.toThrow(/ID de sessão inválido/)
    })
  })

  describe('Codex', () => {
    it('acha o rollout certo entre vários do mesmo projeto', async () => {
      const alvo = randomUUID()
      writeCodex(randomUUID(), project)
      const file = writeCodex(alvo, project, undefined, 20_000, { day: '23' })
      writeCodex(randomUUID(), project, undefined, 0, { day: '22' })

      expect(await sessionArtifacts('codex', alvo, project, roots())).toEqual([real(file)])
    })

    it('ignora rollout com o mesmo id mas de outra pasta', async () => {
      const id = randomUUID()
      const meu = writeCodex(id, project.toUpperCase())
      writeCodex(id, 'C:\\outro', undefined, 0, { day: '23' })

      expect(await sessionArtifacts('codex', id, project, roots())).toEqual([real(meu)])
      expect(await sessionArtifacts('codex', id, 'C:\\terceiro', roots())).toEqual([])
    })

    it('o id vale pela session_meta, não pelo nome do arquivo', async () => {
      const id = randomUUID()
      writeCodex(id, project, undefined, 0, { meta: { id: randomUUID() } })
      expect(await sessionArtifacts('codex', id, project, roots())).toEqual([])
    })

    it('thread de subagente não é apagável sozinha, assim como não aparece na listagem', async () => {
      const principal = randomUUID()
      const sub = randomUUID()
      writeCodex(principal, project)
      writeCodex(sub, project, undefined, 0, {
        meta: { parent_thread_id: principal, source: { subagent: { thread_spawn: {} } } }
      })

      expect(await sessionArtifacts('codex', sub, project, roots())).toEqual([])
    })

    it('sessão inexistente (com ou sem pasta sessions) devolve lista vazia', async () => {
      expect(await sessionArtifacts('codex', randomUUID(), project, roots())).toEqual([])
      writeCodex(randomUUID(), project)
      expect(await sessionArtifacts('codex', randomUUID(), project, roots())).toEqual([])
    })

    it('não inclui nem altera o session_index.jsonl', async () => {
      const id = randomUUID()
      const file = writeCodex(id, project)
      const index = join(codexRoot, 'session_index.jsonl')
      const body = jsonl({ id, thread_name: 'x', updated_at: '2026-09-24T12:00:00Z' })
      writeFileSync(index, body)

      expect(await sessionArtifacts('codex', id, project, roots())).toEqual([real(file)])
      expect(readFileSync(index, 'utf8')).toBe(body)
    })
  })

  describe('segurança: nada fora das raízes', () => {
    let fora: string
    beforeEach(() => {
      fora = mkdtempSync(join(tmpdir(), 'kora-fora-'))
    })

    const insideRoots = (paths: string[]): boolean =>
      paths.every((p) =>
        [real(claudeRoot), real(codexRoot)].some((root) => p.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`))
      )

    it('Claude: pasta irmã que é junction para fora não é devolvida', async () => {
      const id = randomUUID()
      writeClaude(id, jsonl(userLine('oi')))
      writeFileSync(join(fora, 'precioso.txt'), 'não apagar')
      junction(fora, join(claudeProjectDir(claudeRoot, project), id))

      const paths = await sessionArtifacts('claude', id, project, roots())

      expect(paths).toEqual([transcript(id)])
      expect(insideRoots(paths)).toBe(true)
    })

    it('Claude: pasta do projeto que é junction para fora não devolve nada', async () => {
      const id = randomUUID()
      writeFileSync(join(fora, `${id}.jsonl`), jsonl(userLine('oi')))
      mkdirSync(join(fora, id))
      mkdirSync(join(claudeRoot, 'projects'), { recursive: true })
      junction(fora, claudeProjectDir(claudeRoot, project))

      expect(await sessionArtifacts('claude', id, project, roots())).toEqual([])
    })

    it('Codex: pasta sessions que é junction para fora não devolve nada', async () => {
      const id = randomUUID()
      const dia = join(fora, '2026', '09', '24')
      mkdirSync(dia, { recursive: true })
      writeFileSync(
        join(dia, `rollout-2026-09-24T09-51-33-${id}.jsonl`),
        jsonl({ type: 'session_meta', payload: { id, cwd: project } })
      )
      junction(fora, join(codexRoot, 'sessions'))

      expect(await sessionArtifacts('codex', id, project, roots())).toEqual([])
    })

    it('Codex: subpasta de sessions que é junction para fora é ignorada', async () => {
      const id = randomUUID()
      writeFileSync(
        join(fora, `rollout-2026-09-24T09-51-33-${id}.jsonl`),
        jsonl({ type: 'session_meta', payload: { id, cwd: project } })
      )
      mkdirSync(join(codexRoot, 'sessions', '2026', '09'), { recursive: true })
      junction(fora, join(codexRoot, 'sessions', '2026', '09', '24'))

      expect(await sessionArtifacts('codex', id, project, roots())).toEqual([])
    })
  })
})
