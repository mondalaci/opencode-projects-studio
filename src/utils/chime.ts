/**
 * The attention chimes.
 *
 * Synthesised with the Web Audio API rather than shipped as files: each is two
 * short square-wave notes and a decay, which needs no asset and cannot 404.
 * Played only when the window is not in front of the user, so they never
 * interrupt someone who is already looking at the conversation.
 *
 * Two figures: the rising "coin" for a finished turn or a permission, and the
 * lower growl for a question, so "answer me" does not sound like "you are free".
 * Their gains are balanced against each other, so neither is the one that
 * shouts.
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

let context: AudioContext | null = null
/** Whether the device-change listener is already installed. */
let watchingDevices = false

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

/** Start a figure just far enough ahead that scheduling is never late. */
function play(ctx: AudioContext, figure: (ctx: AudioContext, now: number) => void) {
  try {
    figure(ctx, ctx.currentTime + 0.02)
  } catch {
    // The context closed underneath the figure. The next chime rebuilds it.
    resetAudio()
  }
}

/**
 * Play a figure once the context is running, resuming first when it is suspended
 * so the chime after an unlock is not the one that gets lost. Silently does
 * nothing when audio is unavailable.
 */
function start(figure: (ctx: AudioContext, now: number) => void): boolean {
  const ctx = audio()
  if (!ctx) return false
  if (ctx.state === "suspended") {
    void ctx.resume().then(() => play(ctx, figure)).catch(() => undefined)
    return true
  }
  if (ctx.state !== "running") {
    // "closed" or "interrupted": this context cannot sound, so build a new one.
    resetAudio()
    const fresh = audio()
    if (!fresh) return false
    if (fresh.state === "suspended") {
      void fresh.resume().then(() => play(fresh, figure)).catch(() => undefined)
      return true
    }
    play(fresh, figure)
    return true
  }
  play(ctx, figure)
  return true
}

/**
 * The attention chime: quiet enough to sit under whatever else is playing, and
 * the one a finished turn or a permission gets.
 */
export function playAttentionChime() {
  return start(coin)
}

/** The question chime: an agent is waiting on an answer, not on a grant. */
export function playQuestionChime() {
  return start(question)
}
