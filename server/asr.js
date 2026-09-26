import { spawn } from 'node:child_process';
import { cfg, log } from './config.js';

/**
 * Persistent `crispasr --stream --stream-json` process.
 * Feed 16 kHz s16le mono PCM on write(); receive {type: 'partial'|'final'|'silence'} events.
 */
export class AsrStream {
  constructor(onEvent, onExit) {
    const args = [
      '--stream',
      '--stream-json',
      '--backend', cfg.asrBackend,
      '-m', 'auto',
      '--auto-download',
      '-l', cfg.asrLanguage,
      '--vad',
      '--stream-final-on-silence-ms', String(cfg.asrFinalSilenceMs),
      '--threads', String(cfg.asrThreads),
      '-v',
    ];
    log(`ASR: starting crispasr --stream (backend=${cfg.asrBackend}, model=auto)`);
    this.proc = spawn(cfg.crispasrBin, args, {
      cwd: cfg.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.dead = false;

    let stdoutBuf = '';
    this.proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, i).trim();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        onEvent(ev);
      }
    });

    let stderrLines = 0;
    this.proc.stderr.on('data', (d) => {
      const line = d.toString('utf8').trim();
      if (line) {
        stderrLines++;
        // First lines cover model download progress / load; keep those visible, drop the rest
        if (stderrLines <= 6 || /error|warn|fail/i.test(line)) log(`ASR: ${line.slice(0, 300)}`);
      }
    });

    this.proc.on('error', (e) => {
      log(`ASR: spawn error: ${e.message}`);
      onExit(e);
    });
    this.proc.on('exit', (code) => {
      log(`ASR: process exited (code=${code})`);
      this.dead = true;
      onExit(code === 0 ? null : new Error(`crispasr exited with code ${code}`));
    });
  }

  write(pcmInt16) {
    if (!this.dead && this.proc.stdin.writable) this.proc.stdin.write(Buffer.from(pcmInt16));
  }

  close() {
    if (!this.dead) {
      this.proc.stdin.end();
      setTimeout(() => { if (!this.dead) this.proc.kill(); }, 1500).unref();
    }
  }
}
