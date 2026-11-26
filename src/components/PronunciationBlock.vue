<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { Check, KeyRound, Loader2, Play, Square, Volume2 } from "lucide-vue-next"
import { parsePronunciation } from "@/utils/pronunciation"
import { priceLabel, useSpeech } from "@/stores/speech"
import { heldModifier, registerPronunciation } from "@/stores/shortcuts"

const props = defineProps<{ text: string; autoplay?: boolean }>()

const {
  models,
  error,
  selectedModelID,
  selectedVoice,
  availableVoices,
  keySource,
  hasKey,
  slow,
  loadModels,
  selectModel,
  setVoice,
  setApiKey,
  setSlow,
  synthesize,
} = useSpeech()

const entries = computed(() => parsePronunciation(props.text))

const keyDraft = ref("")
const keySaved = ref(false)

const playingIndex = ref<number | null>(null)
const playingAll = ref(false)
const playError = ref<string | null>(null)

let currentAudio: HTMLAudioElement | null = null
let playToken = 0

function saveKey() {
  const value = keyDraft.value.trim()
  if (!value) return
  setApiKey(value)
  keyDraft.value = ""
  keySaved.value = true
  setTimeout(() => {
    keySaved.value = false
  }, 1400)
  void loadModels()
}

function stop() {
  playToken += 1
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
  playingIndex.value = null
  playingAll.value = false
}

/** Play a synthesized clip, resolving when it ends (or is stopped). */
function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audio.playbackRate = slow.value ? 0.6 : 1
    currentAudio = audio
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      audio.onpause = null
      URL.revokeObjectURL(url)
      if (currentAudio === audio) currentAudio = null
      resolve()
    }
    audio.onended = finish
    audio.onerror = finish
    audio.onpause = finish
    audio.play().catch(finish)
  })
}

async function playEntry(index: number) {
  if (playingIndex.value === index) {
    stop()
    return
  }
  const entry = entries.value[index]
  if (!entry) return
  stop()
  const token = (playToken += 1)
  playError.value = null
  playingIndex.value = index
  try {
    const blob = await synthesize(entry.word)
    if (token !== playToken) return
    await playBlob(blob)
  } catch (err) {
    if (token === playToken) playError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (token === playToken) playingIndex.value = null
  }
}

async function playAll() {
  if (playingAll.value) {
    stop()
    return
  }
  stop()
  const token = (playToken += 1)
  playError.value = null
  playingAll.value = true
  try {
    for (let index = 0; index < entries.value.length; index++) {
      if (token !== playToken) return
      playingIndex.value = index
      const blob = await synthesize(entries.value[index].word)
      if (token !== playToken) return
      await playBlob(blob)
    }
  } catch (err) {
    if (token === playToken) playError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (token === playToken) {
      playingIndex.value = null
      playingAll.value = false
    }
  }
}

/** Alt+V (and the play-all button): stop whatever is playing, else play all. */
function togglePlayback() {
  if (playingAll.value || playingIndex.value !== null) {
    stop()
    return
  }
  void playAll()
}

function onModelChange(event: Event) {
  stop()
  playError.value = null
  selectModel((event.target as HTMLSelectElement).value)
}

function onVoiceChange(event: Event) {
  stop()
  setVoice((event.target as HTMLSelectElement).value)
}

let unregisterShortcut: (() => void) | null = null

onMounted(async () => {
  unregisterShortcut = registerPronunciation(togglePlayback)
  await loadModels()
  if (!props.autoplay) return
  if (!hasKey.value || !entries.value.length) return
  playAll()
})

onBeforeUnmount(() => {
  unregisterShortcut?.()
  stop()
})
</script>

<template>
  <div class="pronunciation">
    <div class="pr-head">
      <span class="pr-title">
        <Volume2 :size="15" /> Pronunciation
        <span v-if="heldModifier !== null && entries.length" class="kbd">Alt V</span>
        <span v-if="keySource === 'server'" class="pr-key-badge" title="Using the connected opencode server's OpenRouter key">
          key: opencode server
        </span>
      </span>
      <div class="pr-controls">
        <select
          class="pr-select"
          :value="selectedModelID"
          :title="selectedModelID"
          aria-label="Speech model"
          @change="onModelChange"
        >
          <option v-for="model in models" :key="model.id" :value="model.id">
            {{ model.name }}{{ priceLabel(model) ? ` — ${priceLabel(model)}` : "" }}
          </option>
        </select>
        <select
          v-if="availableVoices.length"
          class="pr-select pr-voice"
          :value="selectedVoice"
          aria-label="Voice"
          @change="onVoiceChange"
        >
          <option v-for="voice in availableVoices" :key="voice" :value="voice">{{ voice }}</option>
        </select>
        <button class="pr-btn" :class="{ active: slow }" :title="slow ? 'Slow playback on' : 'Slow playback off'" @click="setSlow(!slow)">
          {{ slow ? "0.6×" : "1×" }}
        </button>
        <button
          v-if="entries.length > 1"
          class="pr-btn pr-all"
          :title="playingAll ? 'Stop (Alt+V)' : 'Play all (Alt+V)'"
          @click="playAll"
        >
          <Square v-if="playingAll" :size="13" />
          <Play v-else :size="13" />
        </button>
      </div>
    </div>

    <div v-if="!hasKey" class="pr-key">
      <KeyRound :size="14" />
      <input
        v-model="keyDraft"
        type="password"
        class="pr-key-input"
        placeholder="OpenRouter API key (sk-or-…)"
        spellcheck="false"
        @keydown.enter.prevent="saveKey"
      />
      <button class="pr-btn" :disabled="!keyDraft.trim()" @click="saveKey">
        <Check v-if="keySaved" :size="13" />
        <span v-else>Save</span>
      </button>
      <a class="pr-key-link" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">Get a key</a>
    </div>

    <div v-else-if="entries.length" class="pr-list">
      <button
        v-for="(entry, index) in entries"
        :key="index"
        class="pr-row"
        :class="{ playing: playingIndex === index }"
        :title="playingIndex === index ? 'Stop' : `Play “${entry.word}”`"
        @click="playEntry(index)"
      >
        <span class="pr-play">
          <Loader2 v-if="playingIndex === index" class="pr-spin" :size="15" />
          <Volume2 v-else :size="15" />
        </span>
        <span class="pr-body">
          <span class="pr-line">
            <span class="pr-word">{{ entry.word }}</span>
            <span v-if="entry.ipa" class="pr-ipa">{{ entry.ipa }}</span>
          </span>
          <span v-if="entry.hint" class="pr-hint">{{ entry.hint }}</span>
        </span>
      </button>
    </div>

    <p v-else class="pr-note">No words in this block.</p>

    <p v-if="playError" class="pr-note pr-error">{{ playError }}</p>
    <p v-else-if="error" class="pr-note pr-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.pronunciation {
  margin: 0 0 0.9em;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  overflow: hidden;
}
.pr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.pr-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-right: auto;
}
.pr-key-badge {
  font-size: 10.5px;
  font-weight: 400;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-faint);
}
.pr-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pr-select {
  max-width: 240px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.pr-select:focus {
  border-color: var(--accent);
}
.pr-voice {
  max-width: 180px;
}
.pr-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  min-width: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-muted);
  font-size: 12px;
}
.pr-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.pr-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.pr-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}
.pr-key {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  color: var(--text-muted);
  flex-wrap: wrap;
}
.pr-key-input {
  flex: 1;
  min-width: 180px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}
.pr-key-input:focus {
  border-color: var(--accent);
}
.pr-key-link {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}
.pr-key-link:hover {
  text-decoration: underline;
}
.pr-list {
  display: flex;
  flex-direction: column;
  padding: 4px;
}
.pr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  color: var(--text);
}
.pr-row:hover {
  background: var(--bg-hover);
}
.pr-row.playing {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.pr-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--accent);
}
.pr-row.playing .pr-play {
  color: var(--accent);
}
.pr-spin {
  animation: pr-rotate 0.9s linear infinite;
}
@keyframes pr-rotate {
  to {
    transform: rotate(360deg);
  }
}
.pr-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.pr-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.pr-word {
  font-size: 14px;
  font-weight: 600;
}
.pr-ipa {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
}
.pr-hint {
  font-size: 11.5px;
  color: var(--text-faint);
}
.pr-note {
  margin: 0;
  padding: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
.pr-error {
  color: var(--danger);
}
</style>
