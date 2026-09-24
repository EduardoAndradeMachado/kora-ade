// Som de "sessão parou, esperando você": uma corda dedilhada (Karplus-Strong), como a kora do nome.
// Gerado na hora, sem arquivo de áudio. O ruído que excita a corda é novo a cada toque, então cada
// nota sai um pouco diferente, como numa corda de verdade.

const NOTE_HZ = 349.23
const SECONDS = 1.6
const DECAY = 0.996
const VOLUME = 0.5

let context: AudioContext | null = null
const audio = (): AudioContext => (context ??= new AudioContext())

// Ruído curto circulando num atraso do tamanho de um período, suavizado a cada volta.
function pluck(ctx: AudioContext): AudioBuffer {
  const period = Math.round(ctx.sampleRate / NOTE_HZ)
  const length = Math.round(ctx.sampleRate * SECONDS)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const out = buffer.getChannelData(0)
  const ring = Float32Array.from({ length: period }, () => Math.random() * 2 - 1)
  for (let i = 0, at = 0; i < length; i++) {
    const next = (at + 1) % period
    out[i] = ring[at]!
    ring[at] = DECAY * 0.5 * (ring[at]! + ring[next]!)
    at = next
  }
  return buffer
}

export function playChime(): void {
  const ctx = audio()
  const source = ctx.createBufferSource()
  source.buffer = pluck(ctx)
  const volume = ctx.createGain()
  volume.gain.value = VOLUME
  source.connect(volume).connect(ctx.destination)
  source.start()
}
