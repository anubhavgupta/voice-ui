// Headless round-trip test:
//   kokoro TTS -> PCM -> resample to 16k -> WS "mic" -> ASR final
//   -> LLM (echo mode) -> streaming TTS PCM back over WS.
// Run: npm run e2e   (first run downloads models)
import WebSocket from 'ws';

process.env.BRIDGE_PORT = process.env.BRIDGE_PORT || '3100';
process.env.TTS_PORT = process.env.TTS_PORT || '8092';

const bridgePort = Number(process.env.BRIDGE_PORT);
const ttsPort = Number(process.env.TTS_PORT);
const TTS_URL = `http://127.0.0.1:${ttsPort}`;

const SENTENCE = 'Hello there. This is a round trip test of the voice chat pipeline.';

const tStart = Date.now();
const say = (m) => console.log(`[e2e ${((Date.now() - tStart) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${url}`);
}

// ---- minimal RIFF/WAV parser (16-bit mono) ----
function wavFromPcm(pcm) {
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.byteLength, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.byteLength, 40); pcm.copy(wav, 44);
  return wav;
}

function parseWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, dataOff = -1, dataLen = 0, sampleRate = 0, channels = 1, bits = 16;
  while (off + 8 <= dv.byteLength) {
    const id = buf.toString('ascii', off, off + 4);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === 'data') { dataOff = off + 8; dataLen = size; }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0 || channels !== 1 || bits !== 16) throw new Error(`unexpected wav fmt ch=${channels} bits=${bits}`);
  return new Int16Array(buf.buffer, buf.byteOffset + dataOff, Math.min(dataLen, buf.byteLength - dataOff) >> 1);
}

function resampleLinear(i16, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const outLen = Math.floor(i16.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, i16.length - 1);
    const frac = pos - i0;
    out[i] = Math.round(i16[i0] * (1 - frac) + i16[i1] * frac);
  }
  return out;
}

// ---- 1. start the bridge (spawns TTS server, waits for it) ----
say('starting bridge + TTS server (first run downloads kokoro, ~135MB)');
await import('../server/index.js');
await waitFor(`http://127.0.0.1:${bridgePort}/api/config`, 600000);
say('bridge ready');

// ---- 2. synthesize the reference utterance (also measures TTS on CPU) ----
say('synthesizing reference audio with kokoro');
let refPcm;
{
  const ttsT0 = Date.now();
  let firstByteAt = null;
  const res = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: SENTENCE, stream: true, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`ref TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const chunks = [];
  for await (const c of res.body) {
    if (firstByteAt === null) firstByteAt = Date.now();
    chunks.push(c);
  }
  refPcm = Buffer.concat(chunks);
  const refSec = refPcm.byteLength / 2 / 24000;
  say(`reference TTS: ${refSec.toFixed(2)}s audio, first byte in ${((firstByteAt - ttsT0) / 1000).toFixed(2)}s, total ${((Date.now() - ttsT0) / 1000).toFixed(2)}s (RTF ${((Date.now() - ttsT0) / 1000 / refSec).toFixed(2)})`);
}

// ---- 3. feed it to the bridge as a "mic" over WebSocket ----
const ref16 = resampleLinear(parseWav(wavFromPcm(refPcm)), 24000, 16000);
const refSec = ref16.length / 16000;
say(`opening websocket, streaming ${refSec.toFixed(2)}s of "mic" audio at real time`);
const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws`);
ws.binaryType = 'arraybuffer';

const events = {
  firstPartialAt: null, firstPartialText: '', finalText: null, finalAt: null,
  allFinals: [],
  llmStartAt: null, llmEnd: '', ttsFirstAt: null, ttsEndAt: null,
  ttsBytes: 0, errors: [], audioEndSent: null,
};
let anyAsrEvent = false;

ws.on('message', (data, isBinary) => {
  const now = Date.now();
  if (isBinary) { events.ttsBytes += data.byteLength; if (!events.ttsFirstAt) events.ttsFirstAt = now; return; }
  const m = JSON.parse(data);
  if (m.type.startsWith('asr_') || m.type === 'silence') anyAsrEvent = true;
  if (m.type === 'asr_partial' && events.firstPartialAt === null) {
    events.firstPartialAt = now;
    events.firstPartialText = m.text;
  }
  if (m.type === 'asr_final') { events.finalText = m.text; events.finalAt = now; events.allFinals.push(m.text); }
  if (m.type === 'llm_start') events.llmStartAt = now;
  if (m.type === 'llm_delta') events.llmEnd += m.text;
  if (m.type === 'tts_end') events.ttsEndAt = Date.now();
  if (m.type === 'error') events.errors.push(m.message);
});

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

// Probe with silence until the ASR pipeline (model load + first decode step) is live.
say('probing with silence until ASR pipeline is live (model loads on bridge start)');
const probe = Buffer.alloc(2048);
const probeDeadline = Date.now() + 300000;
while (!anyAsrEvent && Date.now() < probeDeadline) {
  ws.send(probe);
  await sleep(64);
}
if (!anyAsrEvent) throw new Error('ASR never emitted an event during the silence probe');
say(`ASR pipeline live after ${((Date.now() - tStart) / 1000).toFixed(1)}s; streaming reference audio`);

const CHUNK = 1024; // 64 ms at 16 kHz
const silenceChunk = Buffer.alloc(CHUNK * 2);
const tAudioStart = Date.now();
for (let i = 0; i < ref16.length; i += CHUNK) {
  const piece = Buffer.from(ref16.buffer, ref16.byteOffset + i * 2, Math.min(CHUNK, ref16.length - i) * 2);
  ws.send(piece);
  await sleep(64);
}
events.audioEndSent = Date.now();
say(`reference audio sent (wall ${((Date.now() - tAudioStart) / 1000).toFixed(1)}s); streaming trailing silence like a live mic...`);
// A real mic never stops: keep feeding silence so the rolling decoder
// processes the tail of the last sentence and finalizes it.
const silenceDeadline = Date.now() + 4000;
while (Date.now() < silenceDeadline && events.allFinals.length < 2) {
  ws.send(silenceChunk);
  await sleep(64);
}
say('waiting for ASR final + LLM + TTS...');

// ---- 4. wait for the reply audio to finish ----
const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  if (events.finalText && events.ttsEndAt && events.ttsBytes > 1000) break;
  await sleep(250);
}

ws.close();
await sleep(300);

// ---- 5. report ----
const rel = (ms) => (ms === null ? 'MISSING' : ((ms - tStart) / 1000).toFixed(2) + 's');
say('---- results ----');
say(`ASR finals (${events.allFinals.length}): ${events.allFinals.map((t) => `"${t}"`).join('  |  ')}`);
say(`  first partial: ${rel(events.firstPartialAt)} ("${events.firstPartialText.slice(0, 60)}")`);
say(`  final latency: ${events.finalAt ? ((events.finalAt - events.audioEndSent) / 1000).toFixed(2) + 's after last audio (0.8s silence tail + ASR decode)' : 'MISSING'}`);
say(`LLM reply      : "${events.llmEnd.slice(0, 140)}"`);
say(`  final -> LLM start: ${events.llmStartAt && events.finalAt ? ((events.llmStartAt - events.finalAt) / 1000).toFixed(2) + 's' : 'MISSING'}`);
say(`  final -> first TTS audio: ${events.ttsFirstAt && events.finalAt ? ((events.ttsFirstAt - events.finalAt) / 1000).toFixed(2) + 's' : 'MISSING'}`);
say(`TTS reply audio: ${(events.ttsBytes / 2 / 24000).toFixed(2)}s, stream complete in ${events.ttsEndAt && events.ttsFirstAt ? ((events.ttsEndAt - events.ttsFirstAt) / 1000).toFixed(2) + 's' : 'MISSING'}`);
say(`errors         : ${events.errors.length ? events.errors.join(' | ') : 'none'}`);

const ok = events.finalText && events.ttsBytes > 1000 && events.llmEnd.length > 0 && events.errors.length === 0;
say(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
