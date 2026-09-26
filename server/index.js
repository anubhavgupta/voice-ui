import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { cfg, log } from './config.js';
import { AsrStream } from './asr.js';
import { TtsServer } from './tts.js';
import { streamChat, extractSentences, cleanForSpeech } from './llm.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Linear fade-in on the first ~15 ms of a 16-bit LE mono PCM chunk.
function fadeHead(buf, rate = cfg.ttsSampleRate, sec = 0.015) {
  const n = Math.min(buf.length >> 1, Math.floor(rate * sec));
  const out = Buffer.from(buf);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * (i / n)), i * 2);
  }
  return out;
}

// ---------- engines (model loaded once, shared by all sessions) ----------
const tts = new TtsServer();
await tts.waitReady();

let asrReady = false;
const sessions = new Set();
let activeSession = null;

function handleAsrEvent(ev) {
  if (!asrReady) {
    asrReady = true;
    if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = null; }
    log('ASR: model ready, engine live');
  }
  const s = activeSession;
  if (!s || s.closed) return;
  if (ev.type === 'partial') {
    if (s.speaking) return;                 // v1: no barge-in; agent audio would self-trigger
    s.send({ type: 'asr_partial', text: ev.text });
  } else if (ev.type === 'final') {
    const text = (ev.text || '').trim();
    if (!text) return;
    if (s.speaking || s.stage === 'thinking') {
      s.pendingFinal = text;                // user talked while agent was busy
      return;
    }
    s.send({ type: 'asr_final', text });
    s.handleTurn(text);
  } else if (ev.type === 'silence') {
    s.send({ type: 'silence', t: ev.t });   // heartbeat; clients may ignore
  }
}

const asr = new AsrStream(handleAsrEvent, (err) => {
  if (activeSession && !activeSession.closed) {
    activeSession.send({ type: 'error', message: err ? err.message : 'ASR engine exited' });
    activeSession.ws.close(1011);
  }
});
log('ASR: starting (model loads in background; first run downloads ~467 MB)');

// CrispASR stream mode only starts loading the model once stdin sees data;
// feed silence at boot so it is hot before the first client connects.
let warmupTimer = null;
const runWarmup = () => asr.write(Buffer.alloc(2048)); // 25 ms of silence
warmupTimer = setInterval(runWarmup, 500);

// ---------- static files ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/config') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ttsSampleRate: cfg.ttsSampleRate,
      llmConfigured: Boolean(cfg.llmBaseUrl),
      asrBackend: cfg.asrBackend,
      ttsBackend: cfg.ttsBackend,
    }));
    return;
  }
  if (url.pathname === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ asrReady, ttsReady: true }));
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(cfg.root, 'public', file);
  if (!full.startsWith(path.join(cfg.root, 'public'))) { res.statusCode = 400; res.end('bad path'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(full)] || 'application/octet-stream');
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

// ---------- per-connection voice session ----------
wss.on('connection', (ws) => {
  const session = {
    ws,
    messages: [{ role: 'system', content: cfg.systemPrompt }],
    stage: 'loading',       // loading -> listening -> thinking -> speaking
    speaking: false,        // TTS audio on the wire (ASR ignored while true)
    ttsStarted: false,
    pendingFinal: null,     // user utterance finalized while agent was busy
    ttsQueue: [],           // sentences waiting for synthesis
    ttsDraining: false,
    closed: false,
  };
  sessions.add(session);
  activeSession = session;  // v1: latest connection owns the shared ASR

  session.send = (obj) => { if (!session.closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  session.sendPcm = (buf) => { if (!session.closed && ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(buf)); };

  // One user turn: LLM stream + sentence-fed TTS.
  session.handleTurn = async function (userText) {
    session.messages.push({ role: 'user', content: userText });
    setStage('thinking');
    session.send({ type: 'llm_start' });

    let buffer = '';
    let full = '';
    const feed = (delta) => {
      buffer += delta;
      const { sentences, rest } = extractSentences(buffer);
      buffer = rest;
      if (sentences.length) {
        full += sentences.join(' ') + ' ';
        for (const s of sentences) session.ttsQueue.push(s);
        ttsPump();
      }
    };

    try {
      for await (const delta of streamChat(session.messages)) {
        if (session.closed) break;
        session.send({ type: 'llm_delta', text: delta });
        feed(delta);
      }
      const tail = cleanForSpeech(buffer);
      buffer = '';
      if (tail) { full += tail; session.ttsQueue.push(tail); }
      if (session.ttsQueue.length) ttsPump();
      session.messages.push({ role: 'assistant', content: full.trim() || '(empty reply)' });
      session.send({ type: 'llm_end', text: full.trim() });
    } catch (e) {
      log(`LLM error: ${e.message}`);
      session.send({ type: 'error', message: `LLM: ${e.message}` });
      session.send({ type: 'llm_end', text: full.trim() });
    }
  };

  const setStage = (stage) => {
    session.stage = stage;
    session.send({ type: 'status', stage });
    if (stage === 'listening' && session.pendingFinal) {
      const t = session.pendingFinal;
      session.pendingFinal = null;
      session.send({ type: 'asr_final', text: t });
      session.handleTurn(t);
    }
  };

  // TTS pump: synthesizes queued sentences strictly in order.
  async function ttsPump() {
    if (session.ttsDraining) return;
    session.ttsDraining = true;
    while (session.ttsQueue.length && !session.closed) {
      const text = session.ttsQueue.shift();
      const t0 = Date.now();
      try {
        let first = true;
        for await (let chunk of tts.synthesize(text)) {
          if (session.closed) break;
          // Each sentence is a fresh synthesis: fade in its first samples so
          // sentence boundaries don't pop.
          if (first) { chunk = fadeHead(chunk); first = false; }
          if (!session.ttsStarted) {
            session.ttsStarted = true;
            session.speaking = true;
            setStage('speaking');
            session.send({ type: 'tts_start', sampleRate: cfg.ttsSampleRate });
          }
          session.sendPcm(chunk);
        }
        log(`TTS: "${text.slice(0, 48)}" -> ${((Date.now() - t0) / 1000).toFixed(2)}s`);
      } catch (e) {
        log(`TTS error: ${e.message}`);
        session.send({ type: 'error', message: `TTS: ${e.message}` });
      }
    }
    session.ttsDraining = false;
    if (session.ttsStarted) { session.send({ type: 'tts_end' }); session.ttsStarted = false; }
    session.speaking = false;
    if (!session.closed && session.stage !== 'thinking') setStage('listening');
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      asr.write(data);
    } else {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'reset') {
        session.messages = [{ role: 'system', content: cfg.systemPrompt }];
        session.ttsQueue = [];
        session.pendingFinal = null;
        session.send({ type: 'reset_ok' });
      }
    }
  });

  ws.on('close', () => {
    session.closed = true;
    sessions.delete(session);
    if (activeSession === session) activeSession = sessions.values().next().value || null;
  });

  log(`client connected (${ws._socket.remoteAddress})${asrReady ? '' : ' — ASR model still loading'}`);
  setStage(asrReady ? 'listening' : 'loading');
});

// tell late-arriving clients (and the e2e test) when the ASR model finished loading
setInterval(() => {
  if (asrReady) for (const s of sessions) if (!s.closed && s.stage === 'loading') setStageOf(s, 'listening');
}, 1000).unref();
function setStageOf(s, stage) {
  s.stage = stage;
  s.send({ type: 'status', stage });
}

server.listen(cfg.bridgePort, () => {
  log(`bridge listening on http://127.0.0.1:${cfg.bridgePort} (ws: /ws)`);
  log(`LLM: ${cfg.llmBaseUrl ? cfg.llmBaseUrl + ' model=' + cfg.llmModel : 'not configured (echo mode)'}`);
});

process.on('SIGINT', () => { asr.close(); tts.proc.kill(); process.exit(0); });
