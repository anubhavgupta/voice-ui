const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const draft = $('draft');
const pill = $('pill');
const pillText = $('pillText');
const connectBtn = $('connectBtn');
const resetBtn = $('resetBtn');
const meterFill = $('meterFill');
const toast = $('toast');

let ws = null;
let micCtx = null;
let playCtx = null;
let stream = null;
let agentBubble = null;
let nextEnd = 0;
let playingUntil = 0;
let stage = 'disconnected';
let toastTimer = null;
// Agent audio arrives ~as fast as it plays (TTS RTF ~1), so start playback
// only after a short pre-buffer; otherwise jitter shows up as crackle.
const PREBUFFER_SEC = 0.4;
let pendingPcm = [];
let pendingLen = 0;
let lastPcmAt = 0;
let playbackStarted = false;
let ttsRate = 24000;

const STAGE_LABEL = {
  loading: 'loading models',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  disconnected: 'disconnected',
};

function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.style.display = 'none'), 4000);
}

function setStage(s) {
  stage = s;
  renderStage();
}

// The server reports 'listening' once TTS bytes are fully sent; the pill
// keeps showing 'speaking' until local playback actually drains.
function renderStage() {
  const stillPlaying = playCtx && playingUntil && playCtx.currentTime < playingUntil;
  const shown = (stillPlaying && stage === 'listening') ? 'speaking' : stage;
  pill.className = 'pill ' + (shown === 'disconnected' ? '' : shown);
  pillText.textContent = STAGE_LABEL[shown] || shown;
}

function addUserBubble(text, partial = false) {
  if (partial) { draft.textContent = text; draft.style.display = 'block'; transcript.appendChild(draft); return draft; }
  if (draft.style.display !== 'none') { draft.style.display = 'none'; draft.textContent = ''; }
  const row = document.createElement('div');
  row.className = 'row user';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  row.appendChild(b);
  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
  return b;
}

function startAgentBubble() {
  agentBubble = document.createElement('div');
  agentBubble.className = 'row agent';
  const b = document.createElement('div');
  b.className = 'bubble';
  agentBubble.appendChild(b);
  transcript.appendChild(agentBubble);
  return b;
}

function resampleLinear(f32, fromRate, toRate) {
  if (fromRate === toRate) return f32;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, f32.length - 1);
    const frac = pos - i0;
    out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
  }
  return out;
}

function f32ToI16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

function i16ToFloat32(bytes) {
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
  return f32;
}

// ---- agent audio playback ----
function ensurePlayCtx(rate) {
  if (playCtx && playCtx.sampleRate === rate) return playCtx;
  if (playCtx) playCtx.close();
  playCtx = null;
  try {
    playCtx = new AudioContext({ sampleRate: rate });
  } catch {
    playCtx = new AudioContext();
  }
  nextEnd = 0;
  return playCtx;
}

function schedulePcm(f32) {
  const ctx = playCtx;
  const buf = ctx.createBuffer(1, f32.length, ctx.sampleRate);
  buf.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime + 0.02, nextEnd);
  src.start(startAt);
  nextEnd = startAt + buf.duration;
  playingUntil = nextEnd;
}

// ---- mic capture ----
async function startMic() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micCtx = new AudioContext({ sampleRate: 16000 });
  if (micCtx.state === 'suspended') await micCtx.resume();
  await micCtx.audioWorklet.addModule('mic-worklet.js');
  const node = new AudioWorkletNode(micCtx, 'mic-capture');
  const src = micCtx.createMediaStreamSource(stream);
  src.connect(node);
  const mute = micCtx.createGain();
  mute.gain.value = 0; // keep the graph running without feeding the mic back into the speakers
  node.connect(mute);
  mute.connect(micCtx.destination);

  node.port.onmessage = (e) => {
    const { pcm, rms } = e.data;
    meterFill.style.width = Math.min(100, rms * 400) + '%';
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const sent = f32ToI16(resampleLinear(pcm, micCtx.sampleRate, 16000));
    ws.send(sent.buffer);
  };
}

// ---- websocket ----
function flushPending() {
  if (!pendingLen) return;
  const merged = new Float32Array(pendingLen);
  let off = 0;
  for (const c of pendingPcm) { merged.set(c, off); off += c.length; }
  pendingPcm = [];
  pendingLen = 0;
  playbackStarted = true;
  schedulePcm(merged);
}

function wsHandleMessage(data, isBinary) {
  if (isBinary) {
    const f32 = i16ToFloat32(new Uint8Array(data));
    lastPcmAt = Date.now();
    if (!playbackStarted) {
      pendingPcm.push(f32);
      pendingLen += f32.length;
      if (pendingLen >= Math.floor(ttsRate * PREBUFFER_SEC)) flushPending();
      return;
    }
    schedulePcm(f32);
    return;
  }
  const m = JSON.parse(data);
  switch (m.type) {
    case 'status':
      setStage(m.stage);
      break;
    case 'asr_partial':
      addUserBubble(m.text, true);
      break;
    case 'asr_final':
      addUserBubble(m.text);
      break;
    case 'llm_start':
      agentBubble = startAgentBubble();
      break;
    case 'llm_delta':
      if (agentBubble) {
        agentBubble.textContent += m.text;
        transcript.scrollTop = transcript.scrollHeight;
      }
      break;
    case 'llm_end':
      break;
    case 'tts_start':
      ensurePlayCtx(m.sampleRate);
      if (playCtx.state === 'suspended') playCtx.resume();
      nextEnd = 0;
      ttsRate = m.sampleRate;
      playbackStarted = false;
      pendingPcm = [];
      pendingLen = 0;
      break;
    case 'tts_end':
      // stage flips to 'listening' from the server; keep pill accurate until playback drains
      if (!playbackStarted) flushPending();
      break;
    case 'error':
      showToast(m.message);
      break;
    case 'reset_ok':
      break;
  }
}

function connect() {
  connectBtn.disabled = true;
  setStage('disconnected');
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = async () => {
    try {
      await startMic();
    } catch (e) {
      showToast('Mic error: ' + e.message);
      ws.close();
      return;
    }
    resetBtn.disabled = false;
  };
  ws.onmessage = (e) => wsHandleMessage(e.data, e.data instanceof ArrayBuffer);
  ws.onclose = () => {
    setStage('disconnected');
    connectBtn.disabled = false;
    resetBtn.disabled = true;
  };
  ws.onerror = () => showToast('WebSocket error');
}

connectBtn.addEventListener('click', connect);
resetBtn.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'reset' }));
    transcript.querySelectorAll('.row').forEach((n) => n.remove());
  }
});

setInterval(() => {
  renderStage();
  // stream slower than the pre-buffer target: start with what we have
  if (!playbackStarted && pendingLen > 0 && Date.now() - lastPcmAt > 300) flushPending();
}, 250);

fetch('/api/config').then((r) => r.json()).then((c) => {
  if (!c.llmConfigured) $('llmPill').style.display = 'inline-flex';
}).catch(() => {});
