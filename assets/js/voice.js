// Voice commands: turns speech into text (either through a configured speech-to-text
// server or the browser's built-in Web Speech API) and maps the text onto player actions.

const VOICE_TARGET_SAMPLE_RATE = 16000 // Whisper-style models expect 16kHz mono
// Speech is detected relative to the background noise (e.g. music playing in the room). The
// background is the quietest moment of the last VOICE_NOISE_WINDOW, so pauses between words reveal it.
const VOICE_NOISE_WINDOW = 1500 // How far back to look for the background level (ms)
const VOICE_MIN_SPEECH_LEVEL = 0.01 // RMS level always required for speech, for quiet rooms
const VOICE_SPEECH_RATIO = 2.5 // Speech must be this many times louder than the background
const VOICE_SILENCE_TIMEOUT = 1000 // Stop recording after this much silence following speech (ms)
const VOICE_NO_SPEECH_TIMEOUT = 5000 // Give up if nothing was said (ms)
const VOICE_MAX_DURATION = 10000 // Hard limit for a single command (ms)
const VOICE_PLAY_CALLBACK = "voice-play" // getTracks callback for songs requested by voice

const VOICE_COMMANDS = [
    {
        pattern: /^(?:pause|stop)(?: (?:the )?(?:music|song|track|player|playback))?$/,
        run: (player) => !player.isPaused && player.togglePause(),
    },
    {
        pattern: /^(?:resume|continue|unpause|play)(?: (?:the )?(?:music|song|track|player|playback))?$/,
        run: (player) => player.isPaused && player.togglePause(),
    },
    {
        pattern: /^(?:skip|next)(?: (?:the )?(?:track|song))?$/,
        run: (player) => player.skipTo(),
    },
    {
        pattern: /^(?:previous|back|go back)(?: (?:track|song))?$/,
        run: (player) => player.backTo(),
    },
    {
        pattern: /^shuffle(?: (?:the )?queue)?$/,
        run: (player) => player.shuffle(),
    },
    {
        pattern: /^(?:repeat|loop)(?: mode)?$/,
        run: (player) => player.repeatMode(),
    },
    {
        pattern: /^(?:set (?:the )?)?volume (?:to )?(\d{1,3})(?: ?%| percent)?$/,
        run: (player, match) => setVoiceVolume(player, parseInt(match[1])),
    },
    {
        pattern: /^(?:volume up|louder|turn (?:it )?up)$/,
        run: (player) => setVoiceVolume(player, parseInt(player.volumeBar.val()) + 10),
    },
    {
        pattern: /^(?:volume down|quieter|turn (?:it )?down)$/,
        run: (player) => setVoiceVolume(player, parseInt(player.volumeBar.val()) - 10),
    },
    {
        pattern: /^(?:skip |fast )?forward(?: (\d+) seconds?)?$/,
        run: (player, match) => player.seekTo(player.currentPosition + (parseInt(match[1]) || 10) * 1000),
    },
    {
        pattern: /^rewind(?: (\d+) seconds?)?$/,
        run: (player, match) => player.seekTo(player.currentPosition - (parseInt(match[1]) || 10) * 1000),
    },
    {
        // Song names may be in any language. "plej"/"pley" is how Whisper sometimes spells "play"
        // when it detects the clip as Polish because of a Polish song name.
        pattern: /^(?:play|plej|pley|queue|add)(?: (?:the )?song)? (.+?)(?: to (?:the )?queue)?$/,
        run: (player, match) => playFirstFromVoice(player, match[1]),
    },
    {
        pattern: /^search(?: for)? (.+)$/,
        needsBot: false,
        run: (player, match) => searchFromVoice(match[1]),
    },
]

function setVoiceVolume(player, volume) {
    player.send({ op: "updateVolume", volume: Math.max(0, Math.min(100, volume)) })
}

// Look the song up the same way the search bar does, then queue only the best match
function playFirstFromVoice(player, query) {
    player.send({ op: "getTracks", query: query, callback: VOICE_PLAY_CALLBACK })
}

function handleVoicePlayResult(player, tracks) {
    if (!tracks.length) {
        return player.tm.showToast("error", localeTexts.voice.noResults)
    }
    player.send({ op: "addTracks", tracks: [tracks[0]], type: "addToQueue" })
}

function searchFromVoice(query) {
    $("#search-query").val(query).trigger("input").focus()
}

function escapeHtml(text) {
    return $("<div>").text(text).html()
}

function downsampleBuffer(buffer, fromRate, toRate) {
    if (toRate >= fromRate) return buffer

    const ratio = fromRate / toRate
    const result = new Float32Array(Math.floor(buffer.length / ratio))
    for (let i = 0; i < result.length; i++) {
        const start = Math.floor(i * ratio)
        const end = Math.min(Math.floor((i + 1) * ratio), buffer.length)
        let sum = 0
        for (let j = start; j < end; j++) sum += buffer[j]
        result[i] = sum / (end - start)
    }
    return result
}

function encodeWav(samples, sampleRate) {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
    }

    writeString(0, "RIFF")
    view.setUint32(4, 36 + samples.length * 2, true)
    writeString(8, "WAVE")
    writeString(12, "fmt ")
    view.setUint32(16, 16, true) // PCM chunk size
    view.setUint16(20, 1, true) // PCM format
    view.setUint16(22, 1, true) // Mono
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true) // Byte rate
    view.setUint16(32, 2, true) // Block align
    view.setUint16(34, 16, true) // Bits per sample
    writeString(36, "data")
    view.setUint32(40, samples.length * 2, true)

    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return new Blob([view], { type: "audio/wav" })
}

class VoiceCommand {
    constructor(player, config) {
        this.player = player
        this.config = config
        this.$btn = $("#toggle-voice-command")
        this.$label = this.$btn.find(".label")
        this.defaultLabel = this.$label.text()
        this.state = "idle" // idle | listening | processing
        this.recognition = null
        this.recorder = null
    }

    static isSupported(config) {
        // Microphone access is only allowed on HTTPS or localhost
        if (!config?.enabled || !window.isSecureContext) return false

        if (config.useServer) {
            return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext))
        }
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
    }

    init() {
        $("#voice-btn-container").show()
        this.$btn.on("click", () => this.toggle())
    }

    setState(state) {
        this.state = state
        this.$btn.toggleClass("listening", state === "listening").toggleClass("processing", state === "processing")
        this.$btn.find("span").text(state === "processing" ? "progress_activity" : "mic")
        this.$label.text(
            state === "listening" ? localeTexts.voice.listening : state === "processing" ? localeTexts.voice.recognizing : this.defaultLabel
        )
        if (state !== "listening") this.setLevel(0)
    }

    // Grows the ring around the button with the voice, so it is visible that the microphone hears something
    setLevel(level) {
        this.$btn[0].style.setProperty("--voice-level", level.toFixed(2))
    }

    toggle() {
        if (this.state === "listening") return this.stop()
        if (this.state === "processing") return

        this.config.useServer ? this.startRecording() : this.startRecognition()
    }

    stop() {
        if (this.recognition) {
            this.recognition.stop()
        } else if (this.recorder) {
            this.recorder.finish()
        }
    }

    // Built-in browser recognition (no server resources needed)
    startRecognition() {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
        const recognition = new Recognition()
        // Falls back to the page language when no recognition language is configured
        if (this.config.language) recognition.lang = this.config.language
        recognition.interimResults = false
        recognition.maxAlternatives = 1

        recognition.onresult = (event) => this.handleTranscript(event.results[0][0].transcript)
        recognition.onerror = (event) => {
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                this.player.tm.showToast("error", localeTexts.voice.micDenied)
            } else if (event.error === "no-speech") {
                this.player.tm.showToast("info", localeTexts.voice.notHeard)
            } else if (event.error !== "aborted") {
                this.player.tm.showToast("error", localeTexts.voice.transcribeError)
            }
        }
        recognition.onend = () => {
            this.recognition = null
            this.setState("idle")
        }

        this.recognition = recognition
        recognition.start()
        this.setState("listening")
    }

    // Record a short WAV clip and let the configured speech-to-text server transcribe it
    async startRecording() {
        let stream
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
            })
        } catch (error) {
            console.error("Microphone access failed: ", error)
            return this.player.tm.showToast("error", localeTexts.voice.micDenied)
        }

        const AudioCtx = window.AudioContext || window.webkitAudioContext
        const context = new AudioCtx()
        const sampleRate = context.sampleRate
        const source = context.createMediaStreamSource(stream)
        const processor = context.createScriptProcessor(4096, 1, 1)
        const chunks = []
        const startedAt = performance.now()
        const levels = [] // { time, level } of every chunk so far
        let lastSpeechAt = null

        processor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0)
            chunks.push(new Float32Array(input))

            let sum = 0
            for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
            const level = Math.sqrt(sum / input.length)
            const now = performance.now()

            levels.push({ time: now, level })

            const noiseFloor = Math.min(...levels.filter((chunk) => now - chunk.time <= VOICE_NOISE_WINDOW).map((chunk) => chunk.level))
            const threshold = Math.max(VOICE_MIN_SPEECH_LEVEL, noiseFloor * VOICE_SPEECH_RATIO)

            // Look back as well, so speech that started before the background was known still counts
            const lastLoud = levels.findLast((chunk) => chunk.level > threshold)
            if (lastLoud && lastLoud.time > (lastSpeechAt ?? -1)) lastSpeechAt = lastLoud.time

            this.setLevel(Math.min(1, level / threshold / 2))

            const silenceAfterSpeech = lastSpeechAt && now - lastSpeechAt > VOICE_SILENCE_TIMEOUT
            const nothingSaid = !lastSpeechAt && now - startedAt > VOICE_NO_SPEECH_TIMEOUT
            if (silenceAfterSpeech || nothingSaid || now - startedAt > VOICE_MAX_DURATION) {
                this.stop()
            }
        }

        source.connect(processor)
        processor.connect(context.destination) // Required for onaudioprocess to fire in Chromium

        this.recorder = {
            finish: () => {
                this.recorder = null
                processor.onaudioprocess = null
                processor.disconnect()
                source.disconnect()
                stream.getTracks().forEach((track) => track.stop())
                context.close()

                if (!lastSpeechAt) {
                    this.setState("idle")
                    return this.player.tm.showToast("info", localeTexts.voice.notHeard)
                }

                const samples = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
                let offset = 0
                chunks.forEach((chunk) => {
                    samples.set(chunk, offset)
                    offset += chunk.length
                })

                const audio = encodeWav(downsampleBuffer(samples, sampleRate, VOICE_TARGET_SAMPLE_RATE), Math.min(sampleRate, VOICE_TARGET_SAMPLE_RATE))
                this.transcribe(audio)
            },
        }
        this.setState("listening")
    }

    async transcribe(audio) {
        this.setState("processing")

        const form = new FormData()
        form.append("audio", audio, "voice.wav")

        try {
            const resp = await fetch("/voice/transcribe", { method: "POST", body: form, credentials: "same-origin" })
            const data = await resp.json()
            if (resp.ok) {
                this.handleTranscript(data.text || "")
            } else {
                console.error("Voice transcription failed: ", data.error)
                this.player.tm.showToast("error", localeTexts.voice.transcribeError)
            }
        } catch (error) {
            console.error("Voice transcription failed: ", error)
            this.player.tm.showToast("error", localeTexts.voice.transcribeError)
        } finally {
            this.setState("idle")
        }
    }

    handleTranscript(text) {
        const transcript = text.trim()
        const command = transcript
            .toLowerCase()
            .replace(/\[[^\]]*]|\([^)]*\)/g, " ") // Whisper annotations like [BLANK_AUDIO] or (music)
            .replace(/[.,!?;:"„”]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()

        if (!command) {
            return this.player.tm.showToast("info", localeTexts.voice.notHeard)
        }

        this.player.tm.showToast("info", formatString(localeTexts.voice.heard, escapeHtml(transcript)))

        for (const { pattern, run, needsBot = true } of VOICE_COMMANDS) {
            const match = command.match(pattern)
            if (!match) continue

            if (needsBot && this.player.selectedBot == null) {
                return this.player.tm.showToast("error", localeTexts.errors.noPlayerError)
            }
            return run(this.player, match)
        }

        // Anything we don't understand becomes a regular search
        searchFromVoice(command)
    }
}

function initVoiceCommands(player) {
    if (typeof voiceConfig === "undefined" || !VoiceCommand.isSupported(voiceConfig)) return

    const voice = new VoiceCommand(player, voiceConfig)
    voice.init()
    return voice
}
