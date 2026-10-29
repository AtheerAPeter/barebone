/**
 * Short sounds played before a spoken message, for fun and to catch the ear:
 * made here from tones and noise, so there are no audio files to ship. Each
 * is made at the voice's sample rate and plays in the same queue as the
 * words, just before them.
 */

export const SOUNDS = [
  'boing',
  'knock',
  'pop',
  'sparkle',
  'drumroll',
  'tada',
  'levelup',
  'womp',
  'uhoh',
  'ding'
] as const
export type Sound = (typeof SOUNDS)[number]

/** About as loud as the voice, whose peaks are near 0.3, so a sound never startles more than the words. */
const PEAK = 0.32
/** A breath between the sound and the words. */
const GAP_S = 0.15

/** A piece of a sound and when it starts, in seconds. Pieces may overlap. */
type Part = [start: number, samples: Float32Array]

export function sound(name: Sound, sampleRate: number): Float32Array {
  const r = sampleRate
  let parts: Part[]
  switch (name) {
    case 'boing':
      parts = [[0, spring(r, 0.75)]]
      break
    case 'knock':
      // Knock knock.
      parts = [
        [0, knock(r)],
        [0.2, knock(r)]
      ]
      break
    case 'pop':
      parts = [[0, pop(r)]]
      break
    case 'sparkle':
      // A quick twinkle up a pentatonic scale, the notes ringing into each other.
      parts = [1568, 1760, 2093, 2349, 2637, 3136].map((f, i) => [i * 0.06, bell(r, f, 0.4)])
      break
    case 'drumroll':
      parts = [...roll(r, 1), [1, crash(r)]]
      break
    case 'tada':
      // C major, up the chord, the top note held.
      parts = after(r, [
        ...[523.25, 659.25, 783.99].map((f) => bell(r, f, 0.13)),
        bell(r, 1046.5, 0.7)
      ])
      break
    case 'levelup':
      // An 8-bit arpeggio, as games play when you level up.
      parts = after(r, [
        ...[523.25, 659.25, 783.99, 1046.5, 1318.5].map((f) => chip(r, f, 0.07)),
        chip(r, 1567.98, 0.3)
      ])
      break
    case 'womp':
      // The sad trombone: three short steps down, then a long, wavering last note.
      parts = after(r, [
        ...[233.08, 220, 207.65].map((f) => horn(r, f, 0.28, false)),
        horn(r, 196, 0.9, true)
      ])
      break
    case 'uhoh':
      parts = after(r, [bell(r, 466.16, 0.22), bell(r, 349.23, 0.45)])
      break
    case 'ding':
      parts = [[0, bell(r, 1318.5, 0.9)]]
      break
  }
  return mix(r, parts)
}

/** Pieces one after another. */
function after(sampleRate: number, pieces: Float32Array[]): Part[] {
  let at = 0
  return pieces.map((samples) => {
    const part: Part = [at, samples]
    at += samples.length / sampleRate
    return part
  })
}

/** The pieces laid out, scaled to the voice's loudness, with a breath after. */
function mix(sampleRate: number, parts: Part[]): Float32Array {
  const end = Math.max(...parts.map(([start, s]) => Math.round(start * sampleRate) + s.length))
  const out = new Float32Array(end + Math.round(GAP_S * sampleRate))
  for (const [start, samples] of parts) {
    const offset = Math.round(start * sampleRate)
    for (let i = 0; i < samples.length; i++) out[offset + i] += samples[i]
  }
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= PEAK / peak
  return out
}

/** `seconds` of sound, sample by sample from `at(time in seconds)`. */
function make(sampleRate: number, seconds: number, at: (s: number) => number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < samples.length; i++) samples[i] = at(i / sampleRate)
  return samples
}

/** A bell-like note: a tone and two overtones, dying away. */
function bell(sampleRate: number, frequency: number, seconds: number): Float32Array {
  return make(sampleRate, seconds, (s) => {
    const w = 2 * Math.PI * frequency * s
    const envelope = Math.min(1, s / 0.005) * Math.exp((-4 * s) / seconds)
    return envelope * (Math.sin(w) + 0.4 * Math.sin(2 * w) + 0.15 * Math.sin(3 * w))
  })
}

/**
 * A cartoon spring: a twangy tone that slides up while its pitch wobbles, the
 * wobble and the sound dying away together.
 */
function spring(sampleRate: number, seconds: number): Float32Array {
  let phase = 0
  return make(sampleRate, seconds, (s) => {
    const wobble = 0.3 * Math.exp(-4 * s) * Math.sin(2 * Math.PI * 14 * s)
    phase += (2 * Math.PI * (220 + 140 * (s / seconds)) * (1 + wobble)) / sampleRate
    const envelope = Math.min(1, s / 0.004) * Math.exp((-3 * s) / seconds)
    // The second harmonic gives it the twang of a spring rather than a pure tone.
    return envelope * (Math.sin(phase) + 0.5 * Math.sin(2 * phase))
  })
}

/** A knuckle on a wooden door: a low thud with a click of noise, gone at once. */
function knock(sampleRate: number): Float32Array {
  const noise = noiseSource(7)
  return make(sampleRate, 0.12, (s) => {
    const thud = Math.sin(2 * Math.PI * (190 - 300 * s) * s) * Math.exp(-s / 0.025)
    return thud + 0.35 * noise() * Math.exp(-s / 0.006)
  })
}

/** A bubble popping: a short drop in pitch. */
function pop(sampleRate: number): Float32Array {
  let phase = 0
  return make(sampleRate, 0.09, (s) => {
    phase += (2 * Math.PI * (900 * Math.exp(-s / 0.03) + 250)) / sampleRate
    return Math.sin(phase) * Math.min(1, s / 0.002) * Math.exp(-s / 0.03)
  })
}

/** A snare roll, quick soft strokes growing louder, lasting `seconds`. */
function roll(sampleRate: number, seconds: number): Part[] {
  const parts: Part[] = []
  for (let at = 0; at < seconds; at += 1 / 22) {
    const noise = noiseSource(Math.round(at * 1000) + 1)
    const loudness = 0.25 + 0.75 * (at / seconds)
    parts.push([at, make(sampleRate, 0.05, (s) => loudness * noise() * Math.exp(-s / 0.015))])
  }
  return parts
}

/** The cymbal and drum that end a roll. */
function crash(sampleRate: number): Float32Array {
  const noise = noiseSource(99)
  return make(sampleRate, 0.8, (s) => {
    const drum = Math.sin(2 * Math.PI * 110 * s) * Math.exp(-s / 0.08)
    return 1.4 * (0.8 * noise() * Math.exp(-s / 0.25) + drum)
  })
}

/** An 8-bit note: a square wave, as old game consoles made them. */
function chip(sampleRate: number, frequency: number, seconds: number): Float32Array {
  return make(sampleRate, seconds, (s) => {
    const square = Math.sign(Math.sin(2 * Math.PI * frequency * s))
    return 0.6 * square * Math.min(1, s / 0.003, (seconds - s) / 0.01)
  })
}

/** A muted trombone note, wavering when `long`. */
function horn(sampleRate: number, frequency: number, seconds: number, long: boolean): Float32Array {
  let phase = 0
  return make(sampleRate, seconds, (s) => {
    const vibrato = long ? 1 + 0.03 * Math.sin(2 * Math.PI * 5 * s) * Math.min(1, s / 0.3) : 1
    phase += (2 * Math.PI * frequency * vibrato) / sampleRate
    // A few harmonics, falling off, for the brassy buzz.
    let tone = 0
    for (let h = 1; h <= 5; h++) tone += Math.sin(h * phase) / h
    return tone * Math.min(1, s / 0.03, (seconds - s) / 0.06)
  })
}

/** Noise that is the same every time, so each sound always sounds the same. */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 31 - 1
  }
}
