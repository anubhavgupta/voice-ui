# voice-ui

Bidirectional voice chat agent: you talk, the agent talks back — in the browser.

Built on **[CrispASR](https://github.com/CrispStrobe/CrispASR)** (one C++ binary for both directions of audio) + any **OpenAI-compatible LLM endpoint**.

```
Browser (mic + speakers)
  │ WebSocket: 16 kHz s16le PCM up · 24 kHz s16le PCM down · JSON events
  ▼
Node bridge (server/index.js)
  ├─ CrispASR ASR   parakeet-tdt-0.6b, --stream --stream-json + VAD  (you → text)
  ├─ OpenAI-compatible /chat/completions (streaming)                 (text → text)
  └─ CrispASR TTS   kokoro, /v1/audio/speech stream:true             (text → you)
```

Turn flow: you stop talking → VAD finalizes the utterance ~800 ms later → LLM reply
streams in → complete sentences are synthesized **while the LLM keeps generating** →
audio starts playing at the first finished sentence.

## Run

```powershell
cd C:\projects\voice-ai-ui
npm install
npm start
# open http://127.0.0.1:3000, click "Connect & enable mic", start talking
```

First run auto-downloads models into `%USERPROFILE%\.cache\crispasr`:
parakeet-tdt-0.6b (~467 MB) + VAD model + kokoro (~135 MB).

Headless pipeline test (also prints CPU RTF numbers):

```powershell
npm run e2e
```

## Config (.env)

| Var | Default | Notes |
|---|---|---|
| `BRIDGE_PORT` | 3000 | Web UI + WebSocket |
| `ASR_BACKEND` | parakeet | Best English ASR; alternatives: whisper, moonshine (faster, English), sensevoice (multilingual) |
| `ASR_FINAL_SILENCE_MS` | 800 | Silence that ends your turn. Lower = snappier, risks cutting off mid-pause |
| `TTS_BACKEND` | kokoro | Fast non-autoregressive, 24 kHz. Alternatives: qwen3-tts, orpheus, chatterbox (better, slower on CPU) |
| `TTS_VOICE` | *(default)* | e.g. `af_heart`, `am_michael`, `bf_emma` for kokoro |
| `LLM_BASE_URL` | *(empty)* | **OpenAI-compatible endpoint**, e.g. `http://localhost:11434/v1`. Empty = built-in echo bot |
| `LLM_API_KEY` | *(empty)* | Bearer key for the endpoint |
| `LLM_MODEL` | *(empty)* | Model name for the endpoint |
| `SYSTEM_PROMPT` | voice-assistant prompt | Tune reply style here |

## Measured CPU performance (Intel Core Ultra 9 275HX, crispasr 0.8.37 cpu build)

_Filled in after `npm run e2e`:_

| Stage | Measured |
|---|---|
| TTS (kokoro-82m) RTF | ≈ 0.94–1.16 — just under realtime; a 13 s reply synthesizes in ~12–14 s |
| TTS first-audio latency | ~1.4–1.6 s warm (first sentence only; ~2.6 s cold, first synth after boot) |
| ASR (parakeet-0.6b) model load | ~9 s at bridge start (cached GGUF; once per boot, not per user) |
| ASR finalization | utterance final ~0.8 s after you stop (VAD silence) + decode; repo reference RTF ≈ 0.39 on other CPUs (decode runs ahead of speech) |
| End of speech → agent starts speaking | **≈ 2.3–2.5 s** (0.8 s silence + ~0.2 s decode + ~1.4 s first-sentence TTS) |

Notes:

- Numbers are from `npm run e2e` runs on this machine (Core Ultra 9 275HX, 8 ggml
  threads, AVX2 CPU build, models cached on disk).
- TTS streams sentence-by-sentence, so the first sentence reaches your ears while
  the rest is still being synthesized — perceived latency is the ~1.4 s first-sentence
  cost, not the full RTF.
- `ASR_FINAL_SILENCE_MS` (default 800) is the main knob: lower it to ~500 for a
  snappier turn hand-off at the cost of cutting off natural mid-sentence pauses.
- The RTX 5090 can halve these numbers with the `cuda13` build (Blackwell needs
  CUDA 13; the stock `cuda` zip is CUDA 12 and lacks sm_120).

## Layout

```
bin/crispasr.exe          CrispASR CPU build (v0.8.37) + openblas.dll
server/index.js           HTTP static + WS session state machine
server/asr.js             persistent crispasr --stream --stream-json process
server/tts.js             persistent crispasr --server (kokoro) + streaming synth
server/llm.js             OpenAI-compatible SSE streaming + sentence splitter
public/                   web client (worklet mic capture, playback queue, transcript)
test/e2e.js               headless round-trip test
```

## Known v1 limitations / next steps

- **No barge-in**: while the agent speaks, your mic is captured but ASR events are
  ignored (agent audio would self-trigger). Interrupt = wait, or click "New conversation".
- **No echo cancellation** between the agent's speakers and your mic (relies on
  browser AEC via `echoCancellation: true`).
- **One active speaker**: one shared ASR process serves all tabs; the most recently
  connected tab owns the transcription stream (others still get TTS replies).
- Barge-in + client-side AEC, streaming LLM voice (e.g. parakeet's lower
  `ASR_FINAL_SILENCE_MS`), wake word, and GPU build (`crispasr-windows-x86_64-cuda13.zip`
  for the RTX 5090) are the natural upgrades.
