import { spawn } from 'node:child_process';
import { cfg, log } from './config.js';

/**
 * Persistent `crispasr --server` process with a TTS backend loaded once.
 * synthesize() streams raw int16 LE mono PCM (backend native rate) for a text input.
 */
export class TtsServer {
  constructor() {
    const args = [
      '--server',
      '--backend', cfg.ttsBackend,
      '-m', 'auto',
      '--auto-download',
      '--host', '127.0.0.1',
      '--port', String(cfg.ttsPort),
      '--threads', String(cfg.ttsThreads),
    ];
    if (cfg.ttsVoice) args.push('--voice', cfg.ttsVoice);
    log(`TTS: starting crispasr --server (backend=${cfg.ttsBackend}, port=${cfg.ttsPort})`);
    this.proc = spawn(cfg.crispasrBin, args, {
      cwd: cfg.root,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.url = `http://127.0.0.1:${cfg.ttsPort}`;
    let stderrLines = 0;
    this.proc.stderr.on('data', (d) => {
      const line = d.toString('utf8').trim();
      if (line) {
        stderrLines++;
        if (stderrLines <= 6 || /error|warn|fail/i.test(line)) log(`TTS: ${line.slice(0, 300)}`);
      }
    });
    this.proc.on('exit', (code) => log(`TTS: server process exited (code=${code})`));
  }

  async waitReady(timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.url}/health`);
        if (res.ok) {
          const j = await res.json();
          up = true;
          log(`TTS: ready (backend=${j.backend}, assumed PCM rate=${cfg.ttsSampleRate} Hz)`);
          break;
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error(`TTS server did not become ready within ${timeoutMs / 1000}s (first run downloads the model)`);
  }

  /** Async iterator of PCM chunks (int16 LE mono at cfg.ttsSampleRate, each buffer sample-aligned). */
  async *synthesize(text) {
    console.log("received:", text);
    const body = { input: text, stream: true, response_format: 'pcm' };
    if (cfg.ttsVoice) body.voice = cfg.ttsVoice;
    const res = await fetch(`${this.url}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`TTS ${res.status}: ${detail.slice(0, 200)}`);
    }
    // Reassemble network chunks into sample-aligned (even-byte) buffers.
    let pending = Buffer.alloc(0);
    for await (const chunk of res.body) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (pending.length >= 2) {
        const aligned = pending.subarray(0, pending.length - (pending.length & 1));
        if (aligned.length) yield aligned;
        pending = pending.subarray(aligned.length);
      }
    }
    // A trailing odd byte is less than one sample; discard.
  }
}
