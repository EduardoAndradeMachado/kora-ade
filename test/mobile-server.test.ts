import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer, request, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileServer } from '../src/main/mobile-server'
import { MobileRuntime } from '../src/main/mobile-runtime'
import { Terminals } from '../src/main/terminals'
import { DESKTOP, type SizeChange } from '../src/main/terminal-sizes'
import { emptyState, type KoraState } from '../src/shared/state'
import type { MobileStatus } from '../src/shared/mobile'
import { mergeTabs } from '../src/main/projects'
import { createTranscriber, type Transcribe } from '../src/main/transcriber'
import transcritor from './fixtures/transcritor-api.json'

const servers: MobileServer[] = []
const processes: Terminals[] = []
const streams: AbortController[] = []
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort()
  for (const server of servers.splice(0)) await server.stop()
  for (const terminals of processes.splice(0)) terminals.killAll()
})

interface Setup {
  server: MobileServer
  runtime: MobileRuntime
  terminals: Terminals
  url: string
  cookie: string
  device: string
  config: string
  dir: string
  // O que o PC recebe do pty, como o main repassa para a janela.
  desktop: () => string
  sizes: { id: string; change: SizeChange }[]
  addTab(id: string): void
  // Contas trocadas pelo celular, na ordem.
  switched: string[]
  // O que a tela de Configurações do PC recebeu, na ordem.
  statuses: MobileStatus[]
}

async function setup(transcribe?: Transcribe): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'kora-mobile-'))
  const config = join(dir, 'mobile.json')
  writeFileSync(join(dir, 'mobile.html'), '<html>Kora mobile</html>')
  mkdirSync(join(dir, 'android'))
  writeFileSync(join(dir, 'android', 'android.json'), '{"versionCode":7,"versionName":"0.7.0"}')
  writeFileSync(join(dir, 'android', 'kora-celular.apk'), 'PK-apk-de-teste')
  let state: KoraState = { ...emptyState(), projects: [{ id: 'p', name: 'Projeto', path: dir }] }
  let desktop = ''
  const sizes: { id: string; change: SizeChange }[] = []
  const switched: string[] = []
  const statuses: MobileStatus[] = []
  let active = 'a1'
  let server: MobileServer | null = null
  const terminals = new Terminals({
    onData: (id, data, sequence) => {
      desktop += data
      server?.publishData(id, data, sequence)
    },
    onExit: () => server?.publishState()
  })
  terminals.setMirroring(true)
  processes.push(terminals)
  const runtime: MobileRuntime = new MobileRuntime({
    state: () => state,
    commit: (next) => { state = next },
    terminals,
    activities: new Map(),
    launch: (tab, cols, rows) => { terminals.spawn(tab.id, dir, cols, rows) },
    changed: () => server?.publishState(),
    sized: (id, change) => sizes.push({ id, change }),
    usage: async () => [
      { agent: 'claude', windows: [{ label: '5 h', usedPercent: 42, resetsAt: Date.now() + 3_600_000, windowMinutes: 300 }], updatedAt: Date.now(), source: 'api' },
      { agent: 'codex', windows: [], updatedAt: Date.now(), source: 'disco', account: 'codex@exemplo.com' }
    ],
    accounts: async () => ({ activeUnknown: false, login: null, accounts: ['a1', 'a2'].map((id) => ({ id, email: `${id}@exemplo.com`, organizationName: null, subscriptionType: 'max', refreshTokenExpiresAt: null, weekly: null, active: id === active })) }),
    switchAccount: async (id) => { switched.push(id); active = id }
  })
  server = new MobileServer({ configFile: config, rendererDir: dir, androidDir: join(dir, 'android'), imageDir: join(dir, 'imagens'), audioDir: join(dir, 'audio'), transcribe, pdfjsDir: resolve('node_modules', 'pdfjs-dist'), runtime, changed: () => {}, statusChanged: (status) => statuses.push(status), port: 0 })
  servers.push(server)
  await server.start()
  const url = `http://127.0.0.1:${(server as unknown as { port: number }).port}`
  const { code } = server.pairing.invite()
  const paired = await fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Celular de teste' }) })
  const cookie = paired.headers.get('set-cookie')!.split(';')[0]!
  const { deviceId: device } = await (await fetch(`${url}/api/state`, { headers: { cookie } })).json()
  const addTab = (id: string): void => { state = mergeTabs(state, [...state.tabs, { id, projectId: 'p', title: 'PC' }]) }
  return { server, runtime, terminals, url, cookie, device, config, dir, desktop: () => desktop, sizes, addTab, switched, statuses }
}

async function action(url: string, cookie: string, command: unknown): Promise<Response> {
  return fetch(`${url}/api/action`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(command) })
}

async function events(url: string, cookie: string): Promise<{ text(): string; close(): void }> {
  const controller = new AbortController()
  streams.push(controller)
  const response = await fetch(`${url}/api/events`, { headers: { cookie }, signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // Conexão encerrada pelo teste.
    }
  })()
  return { text: () => text, close: () => controller.abort() }
}

// Aba aberta pelo PC, como o handler terminal:spawn faz.
function desktopTab(s: Setup, id: string, cols: number, rows: number): void {
  s.addTab(id)
  s.terminals.spawn(id, s.dir, cols, rows)
  s.runtime.launched(id, DESKTOP, { cols, rows })
}

const width = (tag: string): string => `Write-Output ('${tag}=' + $Host.UI.RawUI.WindowSize.Width)\r`

describe('terminal compartilhado entre o PC e o celular', () => {
  it('o que o PC e o celular digitam vai para o mesmo shell e a saída chega aos dois', async () => {
    const s = await setup()
    desktopTab(s, 't', 100, 30)
    const phone = await events(s.url, s.cookie)
    expect((await action(s.url, s.cookie, { type: 'attach', tabId: 't', cols: 60, rows: 20 })).status).toBe(200)
    const pid = s.terminals.pids().get('t')
    s.terminals.write('t', "Write-Output ('DESK' + 'TOP_OK')\r")
    expect((await action(s.url, s.cookie, { type: 'send', tabId: 't', text: "Write-Output ('CELU' + 'LAR_OK')" })).status).toBe(200)
    await expect.poll(() => s.desktop(), { timeout: 15000 }).toContain('CELULAR_OK')
    expect(s.desktop()).toContain('DESKTOP_OK')
    await expect.poll(() => phone.text(), { timeout: 5000 }).toContain('CELULAR_OK')
    expect(phone.text()).toContain('DESKTOP_OK')
    expect(s.terminals.pids().get('t')).toBe(pid)
  })

  it('celular que não está olhando a aba não recebe a saída dela', async () => {
    const s = await setup()
    desktopTab(s, 't', 100, 30)
    const phone = await events(s.url, s.cookie)
    s.terminals.write('t', "Write-Output ('SEM_' + 'ESPIAR')\r")
    await expect.poll(() => s.desktop(), { timeout: 15000 }).toContain('SEM_ESPIAR')
    expect(phone.text()).not.toContain('SEM_ESPIAR')
  })

  it('a largura do shell segue quem interagiu por último e volta ao PC quando o celular sai', async () => {
    const s = await setup()
    desktopTab(s, 't', 100, 30)
    await action(s.url, s.cookie, { type: 'attach', tabId: 't', cols: 50, rows: 20 })
    s.terminals.write('t', width('A'))
    await expect.poll(() => s.desktop(), { timeout: 15000 }).toContain('A=50')
    expect(s.sizes.at(-1)).toEqual({ id: 't', change: { cols: 50, rows: 20, holder: s.device } })
    // Digitar no PC (o renderer chama terminal:take) devolve a largura da janela.
    s.runtime.desktopTake('t')
    s.terminals.write('t', width('B'))
    await expect.poll(() => s.desktop(), { timeout: 15000 }).toContain('B=100')
    // Tecla vinda do celular puxa o tamanho de novo.
    expect((await action(s.url, s.cookie, { type: 'keys', tabId: 't', data: width('C') })).status).toBe(200)
    await expect.poll(() => s.desktop(), { timeout: 15000 }).toContain('C=50')
    expect((await action(s.url, s.cookie, { type: 'detach', tabId: 't' })).status).toBe(200)
    s.terminals.write('t', width('D'))
    await expect.poll(() => s.desktop(), { timeout: 15000 }).toContain('D=100')
    expect((await s.terminals.snapshot('t'))?.cols).toBe(100)
  })

  it('o celular que cai da rede devolve o tamanho ao PC', async () => {
    const s = await setup()
    desktopTab(s, 't', 100, 30)
    const phone = await events(s.url, s.cookie)
    await action(s.url, s.cookie, { type: 'attach', tabId: 't', cols: 50, rows: 20 })
    expect(s.runtime.sizes.holder('t')).toBe(s.device)
    phone.close()
    await expect.poll(() => s.runtime.sizes.holder('t'), { timeout: 6000 }).toBe(DESKTOP)
    expect((await s.terminals.snapshot('t'))?.cols).toBe(100)
  })

  it('a foto da tela traz o que já foi impresso, com a sequência para não repetir', async () => {
    const s = await setup()
    desktopTab(s, 't', 100, 30)
    s.terminals.write('t', "Write-Output ('ANTES_' + 'DA_FOTO')\r")
    await expect.poll(() => s.desktop(), { timeout: 15000 }).toContain('ANTES_DA_FOTO')
    const response = await fetch(`${s.url}/api/snapshot?tab=t`, { headers: { cookie: s.cookie } })
    const snapshot = await response.json()
    expect(snapshot.data).toContain('ANTES_DA_FOTO')
    expect(snapshot.sequence).toBeGreaterThan(0)
  })

  it('celular abre, suspende, retoma e fecha uma aba sem trocar o processo à toa', async () => {
    const s = await setup()
    const { tabId } = await (await action(s.url, s.cookie, { type: 'create', projectId: 'p', kind: 'shell', cols: 80, rows: 24 })).json()
    expect(s.runtime.sizes.holder(tabId)).toBe(s.device)
    const pid = s.terminals.pids().get(tabId)
    expect(pid).toBeDefined()
    expect((await action(s.url, s.cookie, { type: 'resume', tabId, cols: 80, rows: 24 })).status).toBe(200)
    expect(s.terminals.pids().get(tabId)).toBe(pid)
    expect((await action(s.url, s.cookie, { type: 'suspend', tabId })).status).toBe(200)
    expect(s.terminals.pids().has(tabId)).toBe(false)
    expect((await action(s.url, s.cookie, { type: 'keys', tabId, data: 'x' })).status).toBe(400)
    expect((await action(s.url, s.cookie, { type: 'resume', tabId, cols: 80, rows: 24 })).status).toBe(200)
    expect(s.terminals.pids().get(tabId)).not.toBe(pid)
    expect((await action(s.url, s.cookie, { type: 'close', tabId })).status).toBe(200)
    expect(s.runtime.snapshot().tabs).toHaveLength(0)
    expect(s.runtime.sizes.holder(tabId)).toBeNull()
  })

  it('suspender enquanto a foto está sendo tirada não deixa a reconexão pendurada', async () => {
    const s = await setup()
    const { tabId } = await (await action(s.url, s.cookie, { type: 'create', projectId: 'p', kind: 'shell', cols: 80, rows: 24 })).json()
    const pending = s.terminals.snapshot(tabId)
    s.terminals.kill(tabId)
    await expect(pending).resolves.toBeNull()
  })
})

describe('acesso ao servidor do celular', () => {
  it('nega estado e comandos sem pareamento, origem externa e hostname de DNS rebinding', async () => {
    const { url, cookie } = await setup()
    expect((await fetch(`${url}/api/state`)).status).toBe(401)
    expect((await action(url, '', { type: 'keys', tabId: 't', data: 'x' })).status).toBe(401)
    expect((await fetch(`${url}/api/state`, { headers: { cookie, origin: 'https://evil.example' } })).status).toBe(403)
    const rebinding = await new Promise<number | undefined>((resolve) => {
      const req = request(`${url}/api/state`, { headers: { cookie, host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode) })
      req.end()
    })
    expect(rebinding).toBe(403)
    expect((await action(url, cookie, { type: 'create', projectId: 'not-registered', kind: 'shell', cols: 80, rows: 24 })).status).toBe(400)
  })

  it('QR só funciona uma vez, o vínculo sobrevive ao reinício e revogação invalida a credencial', async () => {
    const { server, url, cookie, device, config } = await setup()
    const invitation = server.pairing.invite()
    const payload = { code: invitation.code, name: 'Outro celular' }
    const pair = (): Promise<Response> => fetch(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    expect((await pair()).status).toBe(200)
    expect((await pair()).status).toBe(400)
    const { MobilePairingStore } = await import('../src/main/mobile-pairing')
    const token = cookie.slice(cookie.indexOf('=') + 1)
    expect(new MobilePairingStore(config).authenticate(token)).toBe(device)
    expect(readFileSync(config, 'utf8')).not.toContain(token.split('.')[1])
    server.revoke(device)
    expect((await fetch(`${url}/api/state`, { headers: { cookie } })).status).toBe(401)
  })

  it('o PC fica sabendo na hora do pareamento e de quando o celular abre e fecha o Kora', async () => {
    const s = await setup()
    const paired = s.statuses.at(-1)!.devices.find((device) => device.id === s.device)
    expect(paired).toMatchObject({ name: 'Celular de teste', online: false })
    const phone = await events(s.url, s.cookie)
    await expect.poll(() => s.statuses.at(-1)?.devices.find((device) => device.id === s.device)?.online).toBe(true)
    expect(s.server.status().devices.find((device) => device.id === s.device)?.online).toBe(true)
    phone.close()
    await expect.poll(() => s.statuses.at(-1)?.devices.find((device) => device.id === s.device)?.online, { timeout: 6000 }).toBe(false)
    expect(JSON.stringify(s.server.status())).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
  })

  it('o celular pode ser renomeado pelo PC e por ele mesmo, e o nome persiste', async () => {
    const s = await setup()
    const name = async (): Promise<string> => (await (await fetch(`${s.url}/api/device`, { headers: { cookie: s.cookie } })).json()).name
    expect(await name()).toBe('Celular de teste')
    s.server.rename(s.device, '  Galaxy do PC  ')
    expect(await name()).toBe('Galaxy do PC')
    expect(s.statuses.at(-1)!.devices.find((device) => device.id === s.device)?.name).toBe('Galaxy do PC')
    const renamed = await fetch(`${s.url}/api/device`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Galaxy do celular' }) })
    expect(renamed.status).toBe(200)
    expect(s.server.status().devices.find((device) => device.id === s.device)?.name).toBe('Galaxy do celular')
    expect(s.statuses.at(-1)!.devices.find((device) => device.id === s.device)?.name).toBe('Galaxy do celular')
    const { MobilePairingStore } = await import('../src/main/mobile-pairing')
    expect(new MobilePairingStore(s.config).devices.find((device) => device.id === s.device)?.name).toBe('Galaxy do celular')
    expect((await fetch(`${s.url}/api/device`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '   ' }) })).status).toBe(400)
    expect((await fetch(`${s.url}/api/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Intruso' }) })).status).toBe(401)
    expect(() => s.server.rename(s.device, '')).toThrow()
  })

  it('a nova conexão gera o QR com o endereço da rede local, sem pedir endereço ao PC', async () => {
    const s = await setup()
    const pairing = await s.server.invite()
    const link = new URL(pairing.url)
    expect(link.hostname).toMatch(/^(10|172|192|169)\./)
    expect(link.hash).toMatch(/^#pair=.+/)
    expect(pairing.qr).toMatch(/^data:image\/png;base64,/)
  })

  it('entrega ao app a versão e o APK que vieram no instalador do PC, mesmo sem pareamento', async () => {
    const s = await setup()
    const version = await fetch(`${s.url}/app/android.json`)
    expect(version.status).toBe(200)
    expect(await version.json()).toEqual({ versionCode: 7, versionName: '0.7.0' })
    const apk = await fetch(`${s.url}/app/kora-celular.apk`)
    expect(apk.status).toBe(200)
    expect(apk.headers.get('content-type')).toBe('application/vnd.android.package-archive')
    expect(await apk.text()).toBe('PK-apk-de-teste')
    expect((await fetch(`${s.url}/app/mobile.json`)).status).not.toBe(200)
    expect((await fetch(`${s.url}/app/..%2Fmobile.json`)).status).not.toBe(200)
  })

  it('recebe o print do celular como arquivo no PC, só de celular pareado e só imagem', async () => {
    const s = await setup()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const post = (headers: Record<string, string>, body: Buffer): Promise<Response> => fetch(`${s.url}/api/image`, { method: 'POST', headers, body: new Uint8Array(body) })
    expect((await post({ 'content-type': 'image/png' }, png)).status).toBe(401)
    expect((await post({ cookie: s.cookie, 'content-type': 'text/plain' }, png)).status).toBe(415)
    const sent = await post({ cookie: s.cookie, 'content-type': 'image/png' }, png)
    expect(sent.status).toBe(200)
    const { path } = await sent.json()
    expect(dirname(path)).toBe(join(s.dir, 'imagens'))
    expect(path).toMatch(/\.png$/)
    expect(readFileSync(path)).toEqual(png)
    const huge = await post({ cookie: s.cookie, 'content-type': 'image/jpeg' }, Buffer.alloc(21 * 1024 * 1024))
    expect(huge.status).toBe(413)
    expect(existsSync(join(s.dir, 'imagens'))).toBe(true)
  })

  it('transcreve o áudio do celular pelo Transcritor do PC e não deixa o arquivo para trás', async () => {
    // Transcritor de mentira com as respostas gravadas do de verdade; lê o arquivo na hora, como o de verdade.
    const job = JSON.parse(transcritor.post.body).id as string
    const received: { path: string; bytes: Buffer }[] = []
    const fake: Server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const reply = req.method === 'POST' ? transcritor.post : req.method === 'DELETE' ? transcritor.delete
        : req.url === `/trabalhos/${job}` ? transcritor.job : transcritor.result
      if (req.method === 'POST') {
        const path = JSON.parse(body).arquivo as string
        received.push({ path, bytes: readFileSync(path) })
      }
      res.writeHead(reply.status, { 'content-type': reply.contentType })
      res.end(reply.body)
    })
    await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done))
    const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`
    try {
      const s = await setup(createTranscriber({ url: fakeUrl, token: async () => 'token', pollMs: 5 }))
      const ogg = Buffer.from('OggS-audio-de-teste')
      const post = (headers: Record<string, string>, body: Buffer): Promise<Response> => fetch(`${s.url}/api/audio`, { method: 'POST', headers, body: new Uint8Array(body) })
      expect((await post({ 'content-type': 'audio/ogg' }, ogg)).status).toBe(401)
      expect((await post({ cookie: s.cookie, 'content-type': 'text/plain' }, ogg)).status).toBe(415)
      expect((await post({ cookie: s.cookie, 'content-type': 'audio/ogg' }, Buffer.alloc(0))).status).toBe(400)
      const sent = await post({ cookie: s.cookie, 'content-type': 'audio/ogg; codecs=opus' }, ogg)
      expect(sent.status).toBe(200)
      expect(await sent.json()).toEqual({ text: transcritor.result.body.trim() })
      expect(received).toHaveLength(1)
      expect(received[0]!.bytes).toEqual(ogg)
      expect(received[0]!.path).toMatch(/\.ogg$/)
      expect(dirname(received[0]!.path)).toBe(join(s.dir, 'audio'))
      expect(readdirSync(join(s.dir, 'audio'))).toEqual([])

      await new Promise((done) => fake.close(done))
      const closed = await post({ cookie: s.cookie, 'content-type': 'audio/ogg' }, ogg)
      expect(closed.status).toBe(503)
      expect((await closed.json()).error).toContain('não está aberto')
      expect(readdirSync(join(s.dir, 'audio'))).toEqual([])
    } finally {
      fake.close()
    }
  })

  it('Kora sem Transcritor configurado não aceita áudio', async () => {
    const s = await setup()
    const sent = await fetch(`${s.url}/api/audio`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'audio/ogg' }, body: new Uint8Array([1]) })
    expect(sent.status).toBe(404)
  })

  it('dois Kora no mesmo PC ficam pareados juntos: cada um lê o cookie dele, e o cookie antigo ainda vale', async () => {
    const a = await setup()
    const b = await setup()
    const idA = (await (await fetch(`${a.url}/health`)).json()).id
    const idB = (await (await fetch(`${b.url}/health`)).json()).id
    expect(idA).not.toBe(idB)
    expect(a.cookie.startsWith(`kora-device-${idA}=`)).toBe(true)
    // O navegador manda os dois cookies para os dois (cookie não separa por porta): cada um acha o seu.
    const both = `${a.cookie}; ${b.cookie}`
    expect(await (await fetch(`${a.url}/api/state`, { headers: { cookie: both } })).json()).toMatchObject({ deviceId: a.device })
    expect(await (await fetch(`${b.url}/api/state`, { headers: { cookie: both } })).json()).toMatchObject({ deviceId: b.device })
    // Pareamento de antes do id no nome do cookie continua valendo.
    const legacy = `kora-device=${a.cookie.slice(a.cookie.indexOf('=') + 1)}`
    expect((await fetch(`${a.url}/api/state`, { headers: { cookie: legacy } })).status).toBe(200)
    // O id fica guardado: o mesmo Kora reaberto continua com o mesmo id e reconhece o cookie.
    const { MobilePairingStore } = await import('../src/main/mobile-pairing')
    expect(new MobilePairingStore(a.config).serverId).toBe(idA)
  })

  it('o celular que esquece o PC sai do pareamento: o cookie dele para de valer e o outro celular continua', async () => {
    const s = await setup()
    const { code } = s.server.pairing.invite()
    const other = (await fetch(`${s.url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Outro' }) })).headers.get('set-cookie')!.split(';')[0]!
    const left = await fetch(`${s.url}/api/device`, { method: 'DELETE', headers: { cookie: s.cookie } })
    expect(left.status).toBe(200)
    expect(left.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await fetch(`${s.url}/api/state`, { headers: { cookie: s.cookie } })).status).toBe(401)
    expect(s.server.pairing.devices.map((d) => d.name)).toEqual(['Outro'])
    expect((await fetch(`${s.url}/api/state`, { headers: { cookie: other } })).status).toBe(200)
  })

  it('health informa início congelado e desabilita cache', async () => {
    const { url } = await setup()
    const first = await fetch(`${url}/health`)
    const data = await first.json()
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect((await (await fetch(`${url}/health`)).json()).started_at).toBe(data.started_at)
    expect(data.uptime_seconds).toBeGreaterThanOrEqual(0)
    expect(data.app).toBe('kora')
    expect(data.name).toBe(hostname())
  })

  it('cadastra uma pasta real, detecta quando ela some e revincula preservando as abas', async () => {
    const { url, cookie, runtime } = await setup()
    const root = mkdtempSync(join(tmpdir(), 'kora-mobile-project-'))
    const original = join(root, 'Original')
    mkdirSync(original)
    writeFileSync(join(original, 'arquivo.txt'), 'conteúdo real')
    const folders = await fetch(`${url}/api/folders?path=${encodeURIComponent(root)}`, { headers: { cookie } })
    expect(folders.status).toBe(200)
    expect((await folders.json()).folders).toEqual([{ name: 'Original', path: original }])
    expect((await fetch(`${url}/api/folders?path=${encodeURIComponent(root)}`)).status).toBe(401)
    expect((await action(url, cookie, { type: 'add-project', path: join(root, 'arquivo-inexistente') })).status).toBe(400)
    expect((await action(url, cookie, { type: 'add-project', path: join(original, 'arquivo.txt') })).status).toBe(400)
    expect((await action(url, cookie, { type: 'add-project', path: '.' })).status).toBe(400)
    const added = await action(url, cookie, { type: 'add-project', path: original })
    expect(added.status).toBe(200)
    const { projectId } = await added.json()
    expect((await (await action(url, cookie, { type: 'add-project', path: original })).json()).projectId).toBe(projectId)
    expect(runtime.snapshot().projects).toHaveLength(2)
    const { tabId } = await (await action(url, cookie, { type: 'create', projectId, kind: 'shell', cols: 80, rows: 24 })).json()
    expect((await action(url, cookie, { type: 'suspend', tabId })).status).toBe(200)
    const moved = join(root, 'Corrigida')
    renameSync(original, moved)
    expect(runtime.snapshot().missingProjectIds).toEqual([projectId])
    expect((await action(url, cookie, { type: 'create', projectId, kind: 'shell', cols: 80, rows: 24 })).status).toBe(400)
    expect((await action(url, cookie, { type: 'resume', tabId, cols: 80, rows: 24 })).status).toBe(400)
    expect((await action(url, cookie, { type: 'relocate-project', projectId, path: runtime.snapshot().projects[0]!.path })).status).toBe(400)
    expect((await action(url, cookie, { type: 'relocate-project', projectId, path: moved })).status).toBe(200)
    const snapshot = runtime.snapshot()
    expect(snapshot.missingProjectIds).toEqual([])
    expect(snapshot.projects.find((project) => project.id === projectId)?.path).toBe(moved)
    expect(snapshot.tabs.find((tab) => tab.id === tabId)?.projectId).toBe(projectId)
  })

})

describe('arquivos do projeto pelo celular', () => {
  it('lista, lê e salva só dentro do projeto e não salva por cima do que mudou no disco', async () => {
    const s = await setup()
    mkdirSync(join(s.dir, 'docs'))
    writeFileSync(join(s.dir, 'docs', 'nota.md'), '# Título\r\nlinha do PC\r\n')
    writeFileSync(join(s.dir, 'fora.txt'), 'segredo')
    const get = (path: string, cookie = s.cookie): Promise<Response> => fetch(`${s.url}${path}`, { headers: { cookie } })
    const save = (body: unknown): Promise<Response> => fetch(`${s.url}/api/file`, { method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await get('/api/files?project=p&path=', '')).status).toBe(401)
    expect((await get('/api/file?project=p&path=docs%2Fnota.md', '')).status).toBe(401)

    const root = await (await get('/api/files?project=p&path=')).json()
    expect(root.entries.find((entry: { name: string }) => entry.name === 'docs')).toMatchObject({ isDir: true })
    const docs = await (await get(`/api/files?project=p&path=docs`)).json()
    expect(docs.entries.map((entry: { name: string }) => entry.name)).toEqual(['nota.md'])
    expect((await get(`/api/files?project=p&path=${encodeURIComponent('..')}`)).status).toBe(400)
    expect((await get(`/api/file?project=p&path=${encodeURIComponent('..\\mobile.json')}`)).status).toBe(400)

    const file = await (await get('/api/file?project=p&path=docs%2Fnota.md')).json()
    expect(file.content).toBe('# Título\r\nlinha do PC\r\n')
    const edited = '# Título\r\nlinha do celular\r\n'
    const saved = await save({ projectId: 'p', path: join('docs', 'nota.md'), content: edited, mtimeMs: file.mtimeMs })
    expect(saved.status).toBe(200)
    expect(readFileSync(join(s.dir, 'docs', 'nota.md'), 'utf8')).toBe(edited)

    // O agente mudou o arquivo enquanto ele estava aberto no celular: salvar com a versão antiga é recusado.
    writeFileSync(join(s.dir, 'docs', 'nota.md'), 'o agente escreveu isto')
    const stale = await save({ projectId: 'p', path: join('docs', 'nota.md'), content: 'por cima', mtimeMs: (await saved.json()).mtimeMs - 1000 })
    expect(stale.status).toBe(409)
    expect((await stale.json()).conflict).toBe(true)
    expect(readFileSync(join(s.dir, 'docs', 'nota.md'), 'utf8')).toBe('o agente escreveu isto')
    expect((await save({ projectId: 'p', path: '..\\fora.md', content: 'x', mtimeMs: 0 })).status).toBe(400)
    // Apagado pelo agente com o arquivo aberto: aviso claro, sem o erro do Node com o caminho do PC.
    const gone = await save({ projectId: 'p', path: join('docs', 'sumiu.md'), content: 'x', mtimeMs: 0 })
    expect(gone.status).toBe(404)
    expect((await gone.json()).error).toMatch(/não existe mais no PC/)
    const goneDir = await get('/api/files?project=p&path=pasta-que-sumiu')
    expect(goneDir.status).toBe(404)
    expect(JSON.stringify(await goneDir.json())).not.toContain(s.dir)
  })

  it('entrega o status do git à parte da pasta, e projeto sem git volta sem status', async () => {
    const s = await setup()
    const status = async (): Promise<{ files: { path: string; status: string }[] }> => (await fetch(`${s.url}/api/git?project=p`, { headers: { cookie: s.cookie } })).json()
    expect((await fetch(`${s.url}/api/git?project=p`)).status).toBe(401)
    expect(await status()).toEqual({ files: [] })
    execFileSync('git', ['init', '-q'], { cwd: s.dir })
    writeFileSync(join(s.dir, 'novo.txt'), 'oi')
    expect((await status()).files).toContainEqual(expect.objectContaining({ path: 'novo.txt', status: 'untracked' }))
    // A pasta não traz o status: ela não espera o git status do projeto inteiro.
    expect(Object.keys(await (await fetch(`${s.url}/api/files?project=p&path=`, { headers: { cookie: s.cookie } })).json())).toEqual(['path', 'entries'])
  })

  it('serve ao pdf.js do celular os decodificadores e fontes dele, e nada além dessas pastas', async () => {
    const s = await setup()
    const wasm = await fetch(`${s.url}/pdfjs/wasm/openjpeg.wasm`)
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('content-type')).toBe('application/wasm')
    expect((await fetch(`${s.url}/pdfjs/standard_fonts/FoxitFixed.pfb`)).status).toBe(200)
    expect((await fetch(`${s.url}/pdfjs/build/pdf.mjs`)).status).toBe(404)
    expect((await fetch(`${s.url}/pdfjs/wasm/..%2F..%2Fpackage.json`)).status).toBe(404)
    expect((await fetch(`${s.url}/pdfjs/wasm/%2E%2E/package.json`)).status).toBe(404)
  })

  it('abre o arquivo cru por um link temporário, isolado e preso ao projeto', async () => {
    const s = await setup()
    mkdirSync(join(s.dir, 'site'))
    writeFileSync(join(s.dir, 'site', 'index.html'), '<link rel="stylesheet" href="estilo.css"><h1>Oi</h1>')
    writeFileSync(join(s.dir, 'site', 'estilo.css'), 'h1 { color: red }')
    const { raw } = await (await fetch(`${s.url}/api/file-link?project=p&path=${encodeURIComponent(join('site', 'index.html'))}`, { headers: { cookie: s.cookie } })).json()
    const page = await fetch(`${s.url}${raw}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox /)
    expect(await page.text()).toContain('<h1>Oi</h1>')
    // O CSS da página vem pelo mesmo link, por caminho relativo, sem o cookie e de origem isolada (sandbox).
    const css = await fetch(`${s.url}${raw.replace(/index\.html$/, 'estilo.css')}`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect((await fetch(`${s.url}${raw.replace(/site\/index\.html$/, '..%5Cmobile.json')}`)).status).not.toBe(200)
    // O HTML roda com scripts: o link não lê fora da pasta dele nem arquivo oculto do projeto.
    writeFileSync(join(s.dir, 'segredo.txt'), 'fora da pasta')
    writeFileSync(join(s.dir, 'site', '.env'), 'TOKEN=123')
    expect((await fetch(`${s.url}${raw.replace(/site\/index\.html$/, 'segredo.txt')}`)).status).toBe(403)
    expect((await fetch(`${s.url}${raw.replace(/index\.html$/, '.env')}`)).status).toBe(403)
    // Desvincular o celular derruba os links que ele abriu.
    s.server.revoke(s.device)
    expect((await fetch(`${s.url}${raw}`)).status).toBe(403)
    expect((await fetch(`${s.url}${raw.replace(/^\/raw\/[^/]+/, '/raw/inventado')}`)).status).toBe(403)
  })
})

describe('uso, conta e avisos do PC pelo celular', () => {
  it('mostra limites e contas, troca a conta e muda os avisos do PC', async () => {
    const s = await setup()
    expect((await fetch(`${s.url}/api/usage`)).status).toBe(401)
    const read = async (): Promise<{ usage: { agent: string }[]; accounts: { email: string; active: boolean }[] }> => (await fetch(`${s.url}/api/usage`, { headers: { cookie: s.cookie } })).json()
    const before = await read()
    expect(before.usage.map((usage) => usage.agent)).toEqual(['claude', 'codex'])
    expect(before.accounts.map((account) => [account.email, account.active])).toEqual([['a1@exemplo.com', true], ['a2@exemplo.com', false]])
    expect((await action(s.url, s.cookie, { type: 'switch-account', accountId: 'a2' })).status).toBe(200)
    expect(s.switched).toEqual(['a2'])
    expect((await read()).accounts.find((account) => account.active)?.email).toBe('a2@exemplo.com')

    const stream = await events(s.url, s.cookie)
    expect(s.runtime.snapshot().alerts).toEqual({ sound: true, windowsNotification: true })
    expect((await action(s.url, s.cookie, { type: 'alerts', alerts: { sound: false, windowsNotification: true } })).status).toBe(200)
    expect(s.runtime.snapshot().alerts).toEqual({ sound: false, windowsNotification: true })
    await expect.poll(() => stream.text()).toContain('"alerts":{"sound":false,"windowsNotification":true}')
    expect((await action(s.url, s.cookie, { type: 'alerts', alerts: { sound: 'não' } })).status).toBe(400)
  })
})

describe('abas alteradas por dois clientes', () => {
  it('salvamento atrasado do desktop preserva aba criada no celular', () => {
    const a = { id: 'a', projectId: 'p', title: 'A', titleLocked: false, agent: null }
    const b = { ...a, id: 'b', title: 'B' }
    const state = { ...emptyState(), projects: [{ id: 'p', name: 'P', path: tmpdir() }], tabs: [a, b] }
    expect(mergeTabs(state, [a], [a]).tabs.map((tab) => tab.id)).toEqual(['a', 'b'])
  })

  it('salvamento atrasado não recria aba fechada nem desfaz nome alterado no celular', () => {
    const a = { id: 'a', projectId: 'p', title: 'A', titleLocked: false, agent: null }
    const b = { ...a, id: 'b', title: 'B' }
    const state = { ...emptyState(), projects: [{ id: 'p', name: 'P', path: tmpdir() }], tabs: [{ ...a, title: 'Nome mobile', titleLocked: true }] }
    expect(mergeTabs(state, [a, b], [a, b]).tabs.map((tab) => tab.title)).toEqual(['Nome mobile'])
  })
})
