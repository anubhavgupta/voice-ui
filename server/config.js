import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name, dflt) {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const cfg = {
  root,
  bridgePort: int('BRIDGE_PORT', 3000),
  crispasrBin: path.join(root, 'bin', 'crispasr.exe'),
  asrBackend: process.env.ASR_BACKEND || 'parakeet',
  asrLanguage: process.env.ASR_LANGUAGE || 'en',
  asrFinalSilenceMs: int('ASR_FINAL_SILENCE_MS', 800),
  asrThreads: int('ASR_THREADS', 8),
  ttsBackend: process.env.TTS_BACKEND || 'kokoro',
  ttsPort: int('TTS_PORT', 8091),
  ttsThreads: int('TTS_THREADS', 8),
  ttsVoice: process.env.TTS_VOICE || '',
  // The TTS backend's native PCM rate. Kokoro = 24000 (confirmed by
  // crispasr's own log: "chunks=2 sr=24000Hz"). Override per backend if you
  // switch (e.g. qwen3-tts → 24000, orpheus → 16000, chatterbox → 24000).
  ttsSampleRate: int('TTS_SAMPLE_RATE', 24000),
  llmBaseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || '',
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    'You are a voice assistant. Keep answers short and conversational: one to three sentences. No lists, no markdown, no emoji — your reply is read aloud by a text-to-speech engine.',
};

export function log(msg) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${msg}`);
}
