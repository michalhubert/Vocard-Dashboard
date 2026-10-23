# Voice Commands

The dashboard can be controlled by voice through the microphone button in the header. The browser records a short clip (16 kHz mono WAV), the dashboard forwards it to a speech-to-text server you point it at, and the recognized text is turned into a player action.

The dashboard itself does not run any speech model, so it stays lightweight. The microphone button only appears once a speech-to-text server is configured.

## Supported Commands

| Say | Action |
| --- | --- |
| *pause*, *stop* | Pause the player |
| *play*, *resume*, *continue* | Resume the player |
| *skip*, *next*, *next song* | Skip to the next track |
| *previous*, *back*, *go back* | Go back to the previous track |
| *shuffle* | Shuffle the queue |
| *repeat*, *loop* | Cycle the repeat mode |
| *volume 40*, *set volume to 40%* | Set the volume |
| *volume up / down*, *louder*, *quieter*, *turn it up / down* | Change the volume by 10 |
| *forward*, *skip forward 30 seconds* | Seek forward (10 seconds by default) |
| *rewind*, *rewind 30 seconds* | Seek backward (10 seconds by default) |
| *play &lt;song&gt;*, *add &lt;song&gt; to the queue* | Look the song up like the search bar and add only the first result to the queue |
| *search &lt;query&gt;* | Put the query into the search bar |

Anything that is not recognized as a command is put into the search bar.

Command words are always English, but song and artist names can be in any language. That needs a multilingual model, see [Song Names in Other Languages](#song-names-in-other-languages).

## Configuration

Add a `voice` section to `settings.json` (environment variables in brackets):

```json
"voice": {
    "enable": true,
    "language": "",
    "stt_url": "http://whisper:8080/inference",
    "stt_model": "",
    "stt_api_key": "",
    "stt_prompt": "",
    "browser_recognition": false
}
```

| Key | Description |
| --- | --- |
| `enable` (`VOICE_ENABLE`) | Turn voice commands on or off. |
| `language` (`VOICE_LANGUAGE`) | Optional. Leave empty to let the server detect the spoken language automatically. Set it (e.g. `en-US`, `pl-PL`) to force one language, which is slightly faster and more accurate. Only the first part (`en`, `pl`) is sent to the server. |
| `stt_url` (`VOICE_STT_URL`) | Full URL of the transcription endpoint. |
| `stt_model` (`VOICE_STT_MODEL`) | Model name sent to the server. Required by OpenAI-compatible servers, ignored by whisper.cpp. |
| `stt_api_key` (`VOICE_STT_API_KEY`) | Optional bearer token. |
| `stt_prompt` (`VOICE_STT_PROMPT`) | Optional vocabulary hint sent with every clip. Whisper copies the spelling of words it sees here, so list artist and song names it gets wrong, separated by periods. |
| `browser_recognition` (`VOICE_BROWSER_RECOGNITION`) | Use the browser's built-in recognition when no `stt_url` is set. Off by default because Chrome sends the audio to Google, and Firefox does not support it. |

The browser only allows microphone access when the dashboard is served over HTTPS or from `localhost`.

## Setting Up a Whisper Server

Any server with an OpenAI-compatible `/v1/audio/transcriptions` endpoint, or whisper.cpp's `/inference` endpoint, works. Two self-hosted options are shown below.

### Option 1: whisper.cpp (recommended, lightest)

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) is a small C/C++ implementation of Whisper that runs well on a CPU.

1. Download a model into a folder on the host. Quantized `q5_1` models are smaller and faster with little loss in accuracy:

    ```bash
    mkdir -p ./whisper-models
    docker run --rm -v ./whisper-models:/models ghcr.io/ggml-org/whisper.cpp:main \
      "download-ggml-model.sh base-q5_1 /models"
    ```

2. Run the server:

    ```bash
    docker run -d --name whisper --restart unless-stopped -p 8080:8080 \
      -v ./whisper-models:/models ghcr.io/ggml-org/whisper.cpp:main \
      "whisper-server --host 0.0.0.0 --port 8080 -m /models/ggml-base-q5_1.bin -l auto -t 2"
    ```

3. Check it works:

    ```bash
    curl http://localhost:8080/inference -F file=@some-recording.wav -F response_format=json
    ```

4. Set `"stt_url": "http://<whisper-host>:8080/inference"` in `settings.json` and restart the dashboard.

The image's entrypoint is `bash -c`, so the command must be passed as a single quoted string as shown above. `-l auto` makes whisper.cpp detect the spoken language (its default is English only). When `language` is set in the dashboard, that value is used instead.

### Option 2: Speaches (OpenAI-compatible API)

[Speaches](https://speaches.ai) wraps faster-whisper behind an OpenAI-compatible API and can manage several models.

```bash
docker run -d --name speaches --restart unless-stopped -p 8000:8000 \
  -v hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu

# Download a model once
curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-base
```

Then set:

```json
"stt_url": "http://<speaches-host>:8000/v1/audio/transcriptions",
"stt_model": "Systran/faster-whisper-base"
```

### Docker Compose

Running whisper.cpp next to the dashboard. The model is downloaded on the first start and kept in the volume:

```yaml
services:
  dashboard:
    image: ghcr.io/chocomeow/vocard-dashboard:latest
    environment:
      VOICE_STT_URL: http://whisper:8178/inference
      VOICE_STT_PROMPT: "<artist and song names Whisper misspells>"
    networks:
      - vocard
    # ...the rest of your dashboard config

  whisper:
    container_name: whisper
    image: ghcr.io/ggml-org/whisper.cpp:main
    command: ["[ -f /models/ggml-small-q5_1.bin ] || ./models/download-ggml-model.sh small-q5_1 /models; exec whisper-server --host 0.0.0.0 --port 8178 -m /models/ggml-small-q5_1.bin -l auto -t 2"]
    expose:
      - 8178
    networks:
      - vocard
    restart: unless-stopped
    volumes:
      - /opt/docker/vocard/whisper-models:/models

networks:
  vocard:
```

There's no need to publish the whisper port when only the dashboard talks to it. Leave `language` empty in the dashboard, otherwise it overrides `-l auto`.

## Choosing a Model

| Model | Disk (q5_1) | Notes |
| --- | --- | --- |
| `tiny` | ~31 MB | Fastest. Fine for short commands, weaker with song and artist names. |
| `base` | ~57 MB | Good balance for voice commands. |
| `small` | ~181 MB | Noticeably better with names, slower on weak CPUs. |

Models without `.en` in the name are multilingual. If you only speak English, the `.en` variants (e.g. `base.en-q5_1`) are slightly more accurate.

### Song Names in Other Languages

An `.en` model, or `-l en`, only writes English words: non-English names come out as English-sounding nonsense, and the search can't find it. To use English commands with Polish (or other) song names:

1. Use a multilingual model, `small-q5_1` or larger. `base` and `tiny` often mangle non-English names.
2. Run whisper.cpp with `-l auto` and leave `language` empty in the dashboard.
3. Put names Whisper keeps misspelling into `stt_prompt`. Unusual spellings can't be guessed from audio alone, but Whisper copies them from the prompt.

When a clip is detected as Polish because most of it is a Polish name, Whisper sometimes writes *play* as *plej*. The dashboard accepts that spelling.

### Resource Usage

The server is idle until a command comes in. Each command then uses the CPU in a short burst, usually well under a second for `tiny` or `base` on a modern x86 CPU and a few seconds on a Raspberry Pi. To keep that burst from affecting the bot or Lavalink on the same machine:

- Limit the threads with `-t` (e.g. `-t 2`) so some cores stay free.
- Or run the speech server on a different machine on your network.
- If you have a GPU, use the `main-cuda` or `main-vulkan` images.
