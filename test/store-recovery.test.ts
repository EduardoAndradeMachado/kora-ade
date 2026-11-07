import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupFile, loadState, recoveryMessage, saveState, snapshotDir } from '../src/main/store'
import { emptyState, type KoraState } from '../src/shared/state'

let dir: string
let file: string

const stateWith = (name: string): KoraState => ({
  ...emptyState(),
  groups: [{ id: 'g1', name: 'Clientes' }],
  projects: [{ id: 'p1', name, path: `C:\\x\\${name}`, groupId: 'g1', hidden: true }],
  tabs: [{ id: 't1', projectId: 'p1', title: 'Conversa', titleLocked: true, agent: { kind: 'claude', sessionId: '6f9619ff-8b86-4011-b42d-00c04fc964ff' } }]
})

const zeroOut = (target: string): void => writeFileSync(target, Buffer.alloc(statSync(target).size))
const snapshots = (): string[] => readdirSync(snapshotDir(file)).filter((name) => name.endsWith('.json')).sort()
const snapshotPath = (name: string): string => join(snapshotDir(file), name)
const nameIn = (path: string): unknown => (JSON.parse(readFileSync(path, 'utf8')) as KoraState).projects[0]?.name
const setMtime = (target: string, when: Date): void => utimesSync(target, when, when)
const generationIn = (path: string): number => (JSON.parse(readFileSync(path, 'utf8')) as { generation: number }).generation

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kora-recovery-'))
  file = join(dir, 'kora-state.json')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('recuperação do estado depois de uma queda', () => {
  it('arquivo zerado pela queda volta da gravação anterior, com categorias, pastas e abas', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    zeroOut(file)

    const { state, recovery } = loadState(file)

    expect(state.projects[0]).toMatchObject({ name: 'anterior', groupId: 'g1', hidden: true })
    expect(state.groups).toEqual([{ id: 'g1', name: 'Clientes' }])
    expect(state.tabs[0]?.agent?.sessionId).toBe('6f9619ff-8b86-4011-b42d-00c04fc964ff')
    expect(recovery?.source).not.toBeNull()
    expect(readFileSync(recovery!.corrupt!)).toEqual(Buffer.alloc(statSync(recovery!.corrupt!).size))
  })

  it('recuperar regrava o arquivo principal: a próxima abertura já é normal', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    zeroOut(file)

    loadState(file)

    expect(loadState(file)).toMatchObject({ recovery: null, state: { projects: [{ name: 'anterior' }] } })
  })

  it('segunda queda depois de recuperar ainda acha uma cópia boa', () => {
    saveState(file, stateWith('um'))
    saveState(file, stateWith('dois'))
    zeroOut(file)
    saveState(file, loadState(file).state)
    zeroOut(file)

    expect(loadState(file).state.projects[0]?.name).toBe('um')
  })

  it('queda entre os dois renames: sem principal e sem .tmp, volta do .bak', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    rmSync(file)

    const { state, recovery } = loadState(file)

    expect(state.projects[0]?.name).toBe('anterior')
    expect(recovery?.corrupt).toBeNull()
  })

  it('queda entre os dois renames: a gravação completa no .tmp vence o .bak', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    writeFileSync(`${file}.tmp`, readFileSync(file))
    rmSync(file)

    const { state, recovery } = loadState(file)

    expect(state.projects[0]?.name).toBe('atual')
    expect(recovery?.source).toBe(`${file}.tmp`)
  })

  it('.tmp velho de uma gravação que falhou não vence o .bak mais novo', () => {
    saveState(file, stateWith('velha'))
    const stale = readFileSync(file)
    saveState(file, stateWith('meio'))
    saveState(file, stateWith('nova'))
    writeFileSync(`${file}.tmp`, stale)
    zeroOut(file)

    expect(loadState(file).state.projects[0]?.name).toBe('meio')
  })

  it('gravação completa que parou no .restore também é recuperada e vira o principal', () => {
    saveState(file, stateWith('atual'))
    writeFileSync(`${file}.restore`, readFileSync(file))
    rmSync(file)
    rmSync(snapshotDir(file), { recursive: true })

    expect(loadState(file).state.projects[0]?.name).toBe('atual')
    expect(nameIn(file)).toBe('atual')
    expect(existsSync(`${file}.restore`)).toBe(false)
  })

  it('falha ao regravar a partir do .bak não derruba a abertura nem toca na cópia', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    zeroOut(file)
    mkdirSync(`${file}.restore`)

    expect(loadState(file).state.projects[0]?.name).toBe('anterior')
    expect(nameIn(backupFile(file))).toBe('anterior')
  })

  it('JSON válido fora do formato vai para o lado como danificado, não como arquivo preso', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    for (const invalid of ['null', '{"version":99}']) {
      writeFileSync(file, invalid)

      const { recovery } = loadState(file)

      expect(recovery).toMatchObject({ readOnly: false })
      expect(readFileSync(recovery!.corrupt!, 'utf8')).toBe(invalid)
    }
  })

  it('o aviso mostra a data da cópia usada, não a de agora', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    rmSync(snapshotDir(file), { recursive: true })
    const past = new Date('2026-03-04T15:06:07Z')
    setMtime(backupFile(file), past)
    zeroOut(file)

    expect(recoveryMessage(loadState(file).recovery!)).toContain(past.toLocaleString('pt-BR'))
  })

  it('geração recuperada fica acima de toda foto, mesmo das danificadas', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let hour = 0; hour < 5; hour++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, hour)))
      saveState(file, stateWith(`h${hour}`))
    }
    for (const name of snapshots().slice(1)) zeroOut(snapshotPath(name))
    rmSync(backupFile(file))
    zeroOut(file)

    const { state } = loadState(file)
    saveState(file, state)

    expect(state.projects[0]?.name).toBe('h0')
    expect(generationIn(file)).toBe(6)
  })

  it('relógio errado não promove cópia velha: vale a geração, não a data do arquivo', () => {
    saveState(file, stateWith('velha'))
    saveState(file, stateWith('meio'))
    saveState(file, stateWith('nova'))
    const [foto] = snapshots()
    setMtime(snapshotPath(foto!), new Date(Date.now() + 3 * 3_600_000))
    writeFileSync(`${file}.tmp`, readFileSync(file))
    setMtime(`${file}.tmp`, new Date(Date.now() - 3_600_000))
    zeroOut(file)

    expect(loadState(file).state.projects[0]?.name).toBe('nova')
  })

  it('com a gravação e o .bak perdidos, a foto de geração maior vence e a danificada é pulada', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-06T09:00:00Z'))
    saveState(file, stateWith('antiga'))
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
    saveState(file, stateWith('velha'))
    vi.setSystemTime(new Date('2026-11-06T11:00:00Z'))
    saveState(file, stateWith('nova'))
    vi.useRealTimers()
    const [antiga, velha, nova] = snapshots().map(snapshotPath)
    setMtime(antiga!, new Date(Date.now() + 60_000))
    zeroOut(file)
    zeroOut(backupFile(file))
    zeroOut(nova!)

    const { state, recovery } = loadState(file)

    expect(state.projects[0]?.name).toBe('velha')
    expect(recovery?.source).toBe(velha)
  })

  it('pasta de fotos inválida não impede voltar do .bak', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    rmSync(snapshotDir(file), { recursive: true })
    writeFileSync(snapshotDir(file), 'não é uma pasta')
    zeroOut(file)

    expect(loadState(file).state.projects[0]?.name).toBe('anterior')
  })

  it('sem nenhuma cópia válida abre vazio, avisa e guarda o danificado', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    zeroOut(file)
    zeroOut(backupFile(file))
    for (const name of snapshots()) zeroOut(snapshotPath(name))

    const { state, recovery } = loadState(file)

    expect(state.projects).toEqual([])
    expect(recovery?.source).toBeNull()
    expect(existsSync(recovery!.corrupt!)).toBe(true)
    expect(recoveryMessage(recovery!)).toContain(recovery!.corrupt!)
    expect(recoveryMessage(recovery!)).toContain(snapshotDir(file))
  })

  it('sem principal e só com cópias inválidas também avisa em vez de abrir vazio calado', () => {
    writeFileSync(backupFile(file), Buffer.alloc(100))

    expect(loadState(file).recovery).toMatchObject({ source: null, corrupt: null })
  })

  it('primeira execução não é recuperação', () => {
    expect(loadState(file).recovery).toBeNull()
  })

  it('abrir normalmente não escreve nada', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))
    const before = readFileSync(file)
    const past = new Date(Date.now() - 3_600_000)
    setMtime(file, past)

    loadState(file)

    expect(statSync(file).mtimeMs).toBe(past.getTime())
    expect(readFileSync(file)).toEqual(before)
  })

  it('leitura normal não relata recuperação nem usa cópia', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))

    expect(loadState(file)).toMatchObject({ recovery: null, state: { projects: [{ name: 'atual' }] } })
  })

  it('o campo de geração não vaza para o estado em memória', () => {
    saveState(file, stateWith('atual'))

    expect(loadState(file).state).not.toHaveProperty('generation')
  })
})

describe('cópias do estado', () => {
  it('o .bak guarda a versão anterior, não a atual', () => {
    saveState(file, stateWith('anterior'))
    saveState(file, stateWith('atual'))

    expect(nameIn(backupFile(file))).toBe('anterior')
  })

  it('a geração continua subindo depois de reabrir o app', async () => {
    saveState(file, stateWith('um'))
    saveState(file, stateWith('dois'))

    vi.resetModules()
    const reopened = await import('../src/main/store')
    reopened.saveState(file, reopened.loadState(file).state)

    expect((JSON.parse(readFileSync(file, 'utf8')) as { generation: number }).generation).toBe(3)
  })

  describe('versão anterior gravou por cima (downgrade e nova atualização)', () => {
    const downgrade = (name: string): void => {
      writeFileSync(file, JSON.stringify(stateWith(name)))
    }

    it('a foto velha não vence a lista atual numa recuperação', async () => {
      for (let hour = 0; hour < 3; hour++) {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, hour)))
        saveState(file, stateWith('mes-passado'))
      }
      vi.useRealTimers()
      downgrade('lista-atual')
      vi.resetModules()
      const reopened = await import('../src/main/store')
      const { state } = reopened.loadState(file)
      reopened.saveState(file, state)
      reopened.saveState(file, state)
      zeroOut(file)

      expect(reopened.loadState(file).state.projects[0]?.name).toBe('lista-atual')
    })

    it('a geração volta acima do .bak, não só das fotos', async () => {
      for (let saves = 0; saves < 5; saves++) saveState(file, stateWith('mes-passado'))
      expect(generationIn(backupFile(file))).toBe(4)
      downgrade('lista-atual')
      vi.resetModules()
      const reopened = await import('../src/main/store')

      reopened.loadState(file)

      expect(generationIn(file)).toBe(4)
    })

    it('recuperar logo depois de voltar também acha a lista atual', async () => {
      saveState(file, stateWith('mes-passado'))
      downgrade('lista-atual')
      vi.resetModules()
      const reopened = await import('../src/main/store')
      const { state } = reopened.loadState(file)
      reopened.saveState(file, { ...state, projects: [{ id: 'p2', name: 'nova', path: 'C:\\x\\nova' }] })
      zeroOut(file)

      expect(reopened.loadState(file).state.projects[0]?.name).toBe('lista-atual')
    })

    it('a retenção volta a funcionar: a foto nova entra e a mais velha sai', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      for (let hour = 0; hour < 48; hour++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, hour)))
        saveState(file, stateWith(`velha${hour}`))
      }
      downgrade('lista-atual')
      vi.resetModules()
      const reopened = await import('../src/main/store')
      const { state } = reopened.loadState(file)
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 3, 5)))
      reopened.saveState(file, state)

      expect(snapshots()).toHaveLength(48)
      expect(nameIn(snapshotPath(snapshots().at(-1)!))).toBe('lista-atual')
    })
  })

  it('estado vazio não ocupa o .bak da última lista boa', () => {
    saveState(file, stateWith('boa'))
    saveState(file, emptyState())
    saveState(file, emptyState())
    saveState(file, emptyState())

    expect(nameIn(backupFile(file))).toBe('boa')
  })

  it('.bak preso não impede a gravação principal', () => {
    saveState(file, stateWith('anterior'))
    mkdirSync(backupFile(file))
    writeFileSync(join(backupFile(file), 'ocupa'), 'x')

    saveState(file, stateWith('atual'))

    expect(loadState(file).state.projects[0]?.name).toBe('atual')
    expect(console.error).toHaveBeenCalled()
  })

  it('tira uma foto por hora, e guardar de novo na mesma hora não a reescreve', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-06T10:05:00Z'))
    saveState(file, stateWith('primeira'))
    vi.setSystemTime(new Date('2026-11-06T10:50:00Z'))
    saveState(file, stateWith('segunda'))

    expect(snapshots()).toHaveLength(1)
    expect(nameIn(snapshotPath(snapshots()[0]!))).toBe('primeira')
  })

  it('mantém só as 48 fotos mais novas', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let hour = 0; hour < 50; hour++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, hour)))
      saveState(file, stateWith(`h${hour}`))
    }

    expect(snapshots()).toHaveLength(48)
    expect(nameIn(snapshotPath(snapshots()[0]!))).toBe('h2')
  })

  it('relógio que volta não faz a foto nova ser apagada pela retenção', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let hour = 0; hour < 48; hour++) {
      vi.setSystemTime(new Date(Date.UTC(2030, 0, 1, hour)))
      saveState(file, stateWith(`futuro${hour}`))
    }
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
    saveState(file, stateWith('corrigido'))

    expect(snapshots()).toHaveLength(48)
    expect(nameIn(snapshotPath(snapshots().at(-1)!))).toBe('corrigido')
  })

  it('foto interrompida não ocupa o nome definitivo: a hora ainda consegue guardar a dela', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-06T10:05:00Z'))
    const blocked = snapshotPath('000000000001-2026-11-06T10.json.tmp')
    mkdirSync(blocked, { recursive: true })

    saveState(file, stateWith('falhou'))
    expect(snapshots()).toEqual([])

    rmSync(blocked, { recursive: true })
    saveState(file, stateWith('deu certo'))
    expect(snapshots().map((name) => nameIn(snapshotPath(name)))).toEqual(['deu certo'])
  })

  it('falha ao gravar a foto não apaga as antigas', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let hour = 0; hour < 48; hour++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, hour)))
      saveState(file, stateWith(`h${hour}`))
    }
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 3, 5)))
    mkdirSync(snapshotPath('000000000049-2026-11-03T05.json.tmp'))

    saveState(file, stateWith('falhou'))

    expect(snapshots()).toHaveLength(48)
    expect(nameIn(snapshotPath(snapshots()[0]!))).toBe('h0')
  })

  it('categorias sem nenhum projeto não contam como estado vazio', () => {
    const groups = { ...emptyState(), groups: [{ id: 'g1', name: 'Clientes' }] }
    saveState(file, groups)
    saveState(file, { ...groups, groups: [...groups.groups, { id: 'g2', name: 'Pessoal' }] })
    zeroOut(file)

    expect(loadState(file).state.groups).toEqual([{ id: 'g1', name: 'Clientes' }])
  })

  it('estado vazio não vira foto: abrir zerado não pode empurrar as boas para fora', () => {
    saveState(file, emptyState())

    expect(existsSync(snapshotDir(file))).toBe(false)
  })

  it('falha ao tirar a foto não derruba a gravação principal', () => {
    writeFileSync(snapshotDir(file), 'não é uma pasta')

    saveState(file, stateWith('atual'))

    expect(loadState(file).state.projects[0]?.name).toBe('atual')
    expect(console.error).toHaveBeenCalled()
  })
})
