/**
 * Short sounds played before a spoken message, for fun and to catch the ear:
 * made here from sine tones, so there are no audio files to ship. Each is
 * made at the voice's sample rate and plays in the same queue as the words,
 * just before them.
 */

export const SOUNDS = ['whistle', 'tada', 'uhoh', 'ding'] as const
export type Sound = (typeof SOUNDS)[number]

/** About as loud as the voice, whose peaks are near 0.3, so a sound never startles more than the words. */
const PEAK = 0.32
/** A breath between the sound and the words. */
const GAP_S = 0.15

export function sound(name: Sound, sampleRate: number): Float32Array {
  const parts: Float32Array[] = []
  const add = (part: Float32Array): number => parts.push(part)
  const rest = (seconds: number): number => add(new Float32Array(Math.round(seconds * sampleRate)))
  switch (name) {
    case 'whistle':
      // A two-note "hey, over here": a quick rise, then a rise that falls away.
      add(glide(sampleRate, 0.24, [1100, 2400]))
      rest(0.07)
      add(glide(sampleRate, 0.55, [1200, 2200, 900]))
      break
    case 'tada':
      // C major, up the chord, the top note held.
      for (const frequency of [523.25, 659.25, 783.99]) add(bell(sampleRate, frequency, 0.13))
      add(bell(sampleRate, 1046.5, 0.7))
      break
    case 'uhoh':
      add(bell(sampleRate, 466.16, 0.22))
      add(bell(sampleRate, 349.23, 0.45))
      break
    case 'ding':
      add(bell(sampleRate, 1318.5, 0.9))
      break
  }
  rest(GAP_S)
  return join(parts)
}

/** A whistled tone whose pitch moves through `path` (Hz), with a slight vibrato. */
function glide(sampleRate: number, seconds: number, path: number[]): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate))
  let phase = 0
  for (let i = 0; i < samples.length; i++) {
    const t = i / samples.length
    const at = t * (path.length - 1)
    const from = Math.min(Math.floor(at), path.length - 2)
    const frequency = path[from] + (path[from + 1] - path[from]) * (at - from)
    const vibrato = 1 + 0.012 * Math.sin((2 * Math.PI * 6 * i) / sampleRate)
    phase += (2 * Math.PI * frequency * vibrato) / sampleRate
    // Soft at both ends, as a breath starts and stops.
    const envelope = Math.min(1, t / 0.08, (1 - t) / 0.15)
    samples[i] = PEAK * envelope * Math.sin(phase)
  }
  return samples
}

/** A bell-like note: a tone and two overtones, dying away. */
function bell(sampleRate: number, frequency: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < samples.length; i++) {
    const s = i / sampleRate
    const attack = Math.min(1, s / 0.005)
    const decay = Math.exp((-4 * s) / seconds)
    const w = 2 * Math.PI * frequency * s
    const tone = Math.sin(w) + 0.4 * Math.sin(2 * w) + 0.15 * Math.sin(3 * w)
    samples[i] = (PEAK / 1.55) * attack * decay * tone
  }
  return samples
}

function join(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
