/**
 * The attention chimes.
 *
 * Two recorded figures: the incoming-message blip for a finished turn or a
 * permission, and the two-note error alert for a question, so "answer me" does
 * not sound like "you are free". Both are decoded through the Web Audio API,
 * which hands us gains, scheduling and the device handling below for free.
 *
 * Each recording keeps a synthesised stand-in behind it: if the asset cannot be
 * fetched or decoded, the chime still sounds rather than vanishing, which is the
 * reason the figures were synthesised in the first place.
 *
 * Played only when the window is not in front of the user, so they never
 * interrupt someone who is already looking at the conversation.
 *
 * Electron is configured with `autoplayPolicy: "no-user-gesture-required"`, so
 * the context may start without a click; if a platform still refuses, the context
 * stays suspended and the next interaction resumes it.
 *
 * The context is rebuilt when the system resumes or the audio device set changes:
 * a long-lived context keeps its output stream on the device instance it was
 * created against, so a USB headset that is re-enumerated after a suspend leaves
 * it silent even though it still reports "running".
 */

import attentionRecording from "@/assets/audio/attention-incoming-message.mp3"
import questionRecording from "@/assets/audio/question-error-notification.mp3"

let context: AudioContext | null = null
/** Whether the device-change listener is already installed. */
let watchingDevices = false

/**
 * Peak scale for the recordings. Both files are mastered close to full scale,
 * so they are pulled down to sit where the synthesised figures did — audible
 * under other audio instead of on top of it.
 */
const RECORDED_GAIN = 0.55

/**
 * Drop the shared context, so the next chime builds a fresh one.
 *
 * A long-lived AudioContext does not survive a system resume or a USB audio
 * device being re-enumerated: its output stream stays bound to the device
 * instance that went away, and the context can keep reporting "running" while
 * producing silence. Recreating it is the only reliable way back, so the app
 * calls this after a resume and whenever the device set changes.
 */
export function resetAudio() {
  const ctx = context
  context = null
  if (!ctx) return
  // Close without letting the statechange handler re-enter this function.
  ctx.onstatechange = null
  void ctx.close().catch(() => undefined)
}

/** Lazily create the shared audio context. */
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (context?.state === "closed") resetAudio()
  if (!context) {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    try {
      context = new Ctor()
    } catch {
      return null
    }
    // A context that closes itself (the audio service went away) must not be
    // reused: the next chime would silently schedule into nothing.
    context.onstatechange = () => {
      if (context?.state === "closed") resetAudio()
    }
  }
  if (context.state === "suspended") void context.resume().catch(() => undefined)
  return context
}

/**
 * Unlock audio early, so the first chime is not swallowed by the autoplay policy
 * on platforms that require a gesture.
 */
export function prepareAudio() {
  const ctx = audio()
  if (ctx && ctx.state === "suspended") {
    const unlock = () => {
      void ctx.resume().catch(() => undefined)
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("keydown", unlock)
    }
    window.addEventListener("pointerdown", unlock, { once: true })
    window.addEventListener("keydown", unlock, { once: true })
  }

  // A USB headset that is re-enumerated after a resume leaves the old context
  // bound to a device that no longer exists. Rebuild it when the device set
  // changes, so the next chime is not swallowed.
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices
  if (!watchingDevices && typeof devices?.addEventListener === "function") {
    watchingDevices = true
    devices.addEventListener("devicechange", resetAudio)
  }
}

/** A figure built from oscillators, used when a recording cannot be played. */
type Figure = (ctx: AudioContext, now: number) => void

/** One note of a figure. */
interface Note {
  /** Pitch, in Hz. */
  frequency: number
  /** Seconds after the start of the figure. */
  at: number
  /** How long it sounds, attack included. */
  duration: number
  gain: number
  /** Square by default: an 8-bit blip rather than a sine. */
  type?: OscillatorType
  /** Low-pass corner, to keep the harmonics behind the note instead of in it. */
  cutoff?: number
  /** Resonance at that corner: the higher it is, the more it growls. */
  q?: number
}

/**
 * Play one note, positioned relative to `now`.
 *
 * The envelope is a quick attack into a smooth decay — a blip, not a drone — and
 * the low-pass gives a square wave its edge without its buzz.
 */
function note(ctx: AudioContext, now: number, spec: Note) {
  const startAt = now + spec.at
  const oscillator = ctx.createOscillator()
  const filter = ctx.createBiquadFilter()
  const envelope = ctx.createGain()

  oscillator.type = spec.type ?? "square"
  oscillator.frequency.value = spec.frequency

  filter.type = "lowpass"
  filter.frequency.value = spec.cutoff ?? 5000
  filter.Q.value = spec.q ?? 0.7

  envelope.gain.setValueAtTime(0.0001, startAt)
  envelope.gain.exponentialRampToValueAtTime(spec.gain, startAt + 0.006)
  envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + spec.duration)

  oscillator.connect(filter).connect(envelope).connect(ctx.destination)
  oscillator.start(startAt)
  oscillator.stop(startAt + spec.duration + 0.02)
}

/** A finished turn, or a permission: B5 into E6, the rising coin. */
function coin(ctx: AudioContext, now: number) {
  note(ctx, now, { frequency: 987.8, at: 0, duration: 0.08, gain: 0.2 })
  note(ctx, now, { frequency: 1318.5, at: 0.075, duration: 0.34, gain: 0.18 })
}

/**
 * A question waiting on an answer: two descending notes, with a detuned saw
 * rasping under the second. Lower and slower than the coin, so it reads as "I
 * need something from you" rather than "you are free".
 */
function question(ctx: AudioContext, now: number) {
  note(ctx, now, { frequency: 311.1, at: 0, duration: 0.16, gain: 0.18, cutoff: 1600, q: 3 })
  note(ctx, now, { frequency: 233.1, at: 0.15, duration: 0.42, gain: 0.18, cutoff: 1300, q: 3 })
  note(ctx, now, { frequency: 313.2, at: 0.15, duration: 0.42, gain: 0.11, cutoff: 1300, q: 3, type: "sawtooth" })
}

/** One chime: the recording to prefer and the figure to fall back to. */
interface Sound {
  /** The bundled file, as Vite resolves its URL. */
  url: string
  /** What to play when the file cannot be fetched or decoded. */
  fallback: Figure
}

/** A finished turn, or a permission. */
const attentionSound: Sound = {
  url: attentionRecording,
  fallback: coin,
}

/** A question waiting on an answer. */
const questionSound: Sound = {
  url: questionRecording,
  fallback: question,
}

/**
 * Decoded recordings, kept per context: an AudioBuffer belongs to the context
 * that decoded it, and a reset drops the whole map with the old context.
 */
const decoded = new WeakMap<AudioContext, Map<string, Promise<AudioBuffer | null>>>()

/**
 * Fetch and decode a recording, once per context.
 *
 * A failure is cached too, as a resolved `null`: a file that cannot be decoded
 * will not start decoding on the next chime, and the caller gets its fallback
 * without another round trip.
 */
function decode(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
  let cache = decoded.get(ctx)
  if (!cache) {
    cache = new Map()
    decoded.set(ctx, cache)
  }
  const cached = cache.get(url)
  if (cached) return cached

  const pending = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.arrayBuffer()
    })
    .then((body) => ctx.decodeAudioData(body))
    .catch(() => null)

  cache.set(url, pending)
  return pending
}

/** Start a figure just far enough ahead that scheduling is never late. */
function play(ctx: AudioContext, figure: Figure) {
  try {
    figure(ctx, ctx.currentTime + 0.02)
  } catch {
    // The context closed underneath the figure. The next chime rebuilds it.
    resetAudio()
  }
}

/**
 * Play a recording once it is decoded, falling back to its figure when it cannot
 * be, or when the context went away while it was being decoded.
 */
function playRecording(ctx: AudioContext, sound: Sound, retried: boolean) {
  void decode(ctx, sound.url).then((buffer) => {
    if (!buffer) {
      // Nothing to play from the file: the figure is the guaranteed chime.
      if (ctx.state === "running") play(ctx, sound.fallback)
      return
    }
    if (ctx.state === "closed") {
      // The context was rebuilt under the pending decode; try once on the new one.
      if (!retried) start(sound, true)
      return
    }
    try {
      const source = ctx.createBufferSource()
      const gain = ctx.createGain()
      source.buffer = buffer
      gain.gain.value = RECORDED_GAIN
      source.connect(gain).connect(ctx.destination)
      source.start(ctx.currentTime + 0.02)
    } catch {
      // The context closed underneath the source. The next chime rebuilds it.
      resetAudio()
    }
  })
}

/**
 * Play a chime once the context is running, resuming first when it is suspended
 * so the chime after an unlock is not the one that gets lost. Silently does
 * nothing when audio is unavailable.
 */
function start(sound: Sound, retried = false): boolean {
  const ctx = audio()
  if (!ctx) return false
  if (ctx.state === "suspended") {
    void ctx.resume().then(() => playRecording(ctx, sound, retried)).catch(() => undefined)
    return true
  }
  if (ctx.state !== "running") {
    // "closed" or "interrupted": this context cannot sound, so build a new one.
    resetAudio()
    const fresh = audio()
    if (!fresh) return false
    if (fresh.state === "suspended") {
      void fresh.resume().then(() => playRecording(fresh, sound, retried)).catch(() => undefined)
      return true
    }
    playRecording(fresh, sound, retried)
    return true
  }
  playRecording(ctx, sound, retried)
  return true
}

/**
 * The attention chime: quiet enough to sit under whatever else is playing, and
 * the one a finished turn or a permission gets.
 */
export function playAttentionChime() {
  return start(attentionSound)
}

/** The question chime: an agent is waiting on an answer, not on a grant. */
export function playQuestionChime() {
  return start(questionSound)
}
