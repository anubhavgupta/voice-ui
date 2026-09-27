#!/usr/bin/env node
// podcast-gen.js — Generate a podcast WAV from a JSON file of text segments.
// Uses process-level parallelism with crispasr --tts-output.
//
// Usage:
//   node podcast-gen.js <podcast.json> [options]
//
// Options:
//   --output FILE       output WAV path (default: <input-stem>.wav)
//   --parallel N        number of parallel processes (default: auto = cores)
//   --threads N         threads per process (default: auto = 1 if auto-parallel)
//   --backend NAME      TTS backend (default: qwen3-tts-1.7b-voicedesign)
//   --instruct TEXT     voice description for voicedesign backends (default: "deep calm male voice, slow deliberate pace, podcast narrator style")
//   --language CODE     language to speak, ISO code from the model's codec table
//                       (e.g. en, hi, de). Passed as -tl to crispasr. Default:
//                       json.language if set in the JSON, else auto-detect.
//   --voice PATH        voice pack GGUF or reference WAV
//   --speed X           speaking-rate multiplier (default: 1.0)
//   --limit N           only process first N segments (for testing)
//   --gap-ms N          silence between segments in ms (default: 200)
//   --no-cache          disable the segment cache (always re-synthesize)
//   --verbose           print per-segment timing
//
// Caching:
//   Completed TTS pieces are cached in <input-dir>/.podcast-cache/ keyed by a
//   hash of (text, backend, voice, instruct, speed, language). Re-running —
//   especially after a failure — reuses cached pieces and only synthesizes the
//   ones that are missing. Edit a segment's text (or change voice/settings) and
//   its cache entry is naturally invalidated.
//
// JSON format:
//   {
//     "title": "My Podcast",
//     "segments": [
//       { "id": 0, "text": "First segment..." },
//       { "id": 1, "text": "Second segment..." }
//     ]
//   }

import { readFile, writeFile, mkdir, rm, stat, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";

const CRISPASR = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin", "crispasr.exe");

// ── CLI parsing ──
const argv = process.argv.slice(2);
function getArg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return dflt;
}
function hasFlag(name) {
  return argv.includes(`--${name}`);
}

const inputFile = argv[0];
if (!inputFile) {
  console.error("Usage: node podcast-gen.js <podcast.json> [--output FILE] [--parallel N] [--threads N] [--backend NAME] [--voice PATH] [--speed X] [--limit N] [--gap-ms N] [--verbose]");
  process.exit(1);
}

if (!inputFile.endsWith(".json")) {
  console.error("Input must be a .json file");
  process.exit(1);
}

const outputFile = getArg("output", path.join(path.dirname(inputFile), path.basename(inputFile, ".json") + ".wav"));
const backend = getArg("backend", "qwen3-tts-1.7b-voicedesign");
const voice = getArg("voice", "");
const instruct = getArg("instruct", "deep calm male voice, slow deliberate pace, podcast narrator style");
// Language to speak: flag wins, else json.language, else auto-detect (no flag).
let language = getArg("language", "");
const speed = parseFloat(getArg("speed", "1.0"));
const limit = parseInt(getArg("limit", "0"), 10);
const gapMs = parseInt(getArg("gap-ms", "200"), 10);
const verbose = hasFlag("verbose");
const useCache = !hasFlag("no-cache");

const cpus = os.cpus().length;

// Auto-parallel: 4 concurrent processes (Qwen3-TTS ~1.4GB each),
// each with enough threads to fill the cores: ceil(cores/4) threads each.
// Manual: --parallel N, --threads M
let parallel, threadsPerProc;
if (hasFlag("parallel")) {
  parallel = Math.max(1, parseInt(getArg("parallel", "4"), 10));
  threadsPerProc = hasFlag("threads") ? parseInt(getArg("threads", "1"), 10) : Math.max(1, Math.ceil(cpus / parallel));
} else {
  parallel = Math.min(4, cpus);
  threadsPerProc = Math.max(1, Math.ceil(cpus / parallel));
}

console.log(`Input:      ${inputFile}`);
console.log(`Output:     ${outputFile}`);
console.log(`Backend:    ${backend}`);
console.log(`Parallel:   ${parallel} processes`);
console.log(`Threads:    ${threadsPerProc} per process (${parallel * threadsPerProc} total, ${cpus} cores)`);
console.log(`Gap:        ${gapMs}ms between segments`);
if (voice) console.log(`Voice:      ${voice}`);
if (speed !== 1.0) console.log(`Speed:      ${speed}x`);
if (limit > 0) console.log(`Limit:      first ${limit} segments only`);
if (useCache) console.log(`Cache:      enabled`); else console.log(`Cache:      disabled (--no-cache)`);
console.log("");

// ── Read JSON ──
const json = JSON.parse(await readFile(inputFile, "utf8"));
if (!json.segments || !Array.isArray(json.segments)) {
  console.error("JSON must have a 'segments' array");
  process.exit(1);
}
console.log(`Title:      ${json.title || "(untitled)"}`);
console.log(`Segments:   ${json.segments.length}`);
if (!language && json.language) language = json.language;
if (language) console.log(`Language:   ${language}`);
console.log("");

let segments = json.segments;
if (limit > 0) segments = segments.slice(0, limit);

// ── Temp dir ──
const tmpDir = path.join(os.tmpdir(), "podcast-gen");
await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });

// ── Run one crispasr --tts-output process, returns WAV buffer ──
function runTts(text, outWav, label) {
  return new Promise((resolve, reject) => {
    const cmdArgs = [
      "--backend", backend,
      "--tts", text,
      "--tts-output", outWav,
      "--threads", String(threadsPerProc),
      "-m", "auto",
      "--auto-download",
    ];
    if (language) cmdArgs.push("-tl", language);
    if (voice) cmdArgs.push("--voice", voice);
    if (instruct && backend.includes("voicedesign")) cmdArgs.push("--instruct", instruct);
    if (speed !== 1.0) cmdArgs.push("--tts-speed", String(speed));

    const proc = spawn(CRISPASR, cmdArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    proc.stderr.on("data", (d) => {
      stderrBuf += d.toString();
      if (verbose) process.stderr.write(`  [${label}] ${d.toString().trim()}\n`);
    });

    const t0 = Date.now();
    proc.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(`exit ${code}: ${stderrBuf.slice(-300)}`));
        return;
      }
      try {
        const wav = await readFile(outWav);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        if (verbose) console.log(`  [${label}] done in ${elapsed}s, ${(wav.length / 1024).toFixed(0)} KB`);
        resolve(wav);
      } catch (e) {
        reject(new Error(`failed to read output WAV: ${e.message}`));
      }
    });

    proc.on("error", (e) => reject(new Error(`spawn failed: ${e.message}`)));
  });
}

// ── Piece cache: persist each completed TTS piece, reuse across runs ──
// Keyed by a hash of everything that affects the output. A failed run leaves
// its completed pieces on disk, so a re-run only synthesizes what's missing.
const cacheDir = useCache ? path.join(path.dirname(inputFile), ".podcast-cache") : null;
if (cacheDir) await mkdir(cacheDir, { recursive: true });

function pieceHash(text) {
  const key = JSON.stringify([text, backend, voice, instruct, speed, language]);
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function runTtsPiece(text, label) {
  const hash = pieceHash(text);
  const wavPath = cacheDir ? path.join(cacheDir, hash + ".wav") : path.join(tmpDir, `${label}.wav`);

  if (cacheDir) {
    try {
      const st = await stat(wavPath);
      if (st.size > 44) {
        const wav = await readFile(wavPath);
        if (verbose) console.log(`  [${label}] cache hit`);
        return wav;
      }
    } catch {}
  }

  const wav = await runTts(text, wavPath, label);
  if (cacheDir && !wavPath.startsWith(cacheDir)) {
    // Temp-mode output: move into the cache so a later run can reuse it.
    await writeFile(wavPath, wav).catch(() => {});
  }
  return wav;
}

// ── Run one segment with retry: split in half on failure ──
async function runSegment(idx, seg) {
  const queue = [seg.text];
  const wavs = [];
  const t0 = Date.now();
  let maxRetries = 6;

  while (queue.length > 0 && maxRetries > 0) {
    const piece = queue.shift();
    try {
      const wav = await runTtsPiece(piece, `seg-${String(idx).padStart(4, "0")}-p${String(wavs.length).padStart(2, "0")}`);
      wavs.push(wav);
    } catch (e) {
      console.error(`  [seg ${idx}] "${piece.slice(0, 40)}..." failed: ${e.message.slice(0, 120)}`);
      if (piece.length < 80) {
        throw new Error(`seg ${idx}: piece too short to split (${piece.length} chars): ${e.message.slice(0, 200)}`);
      }
      maxRetries--;
      const mid = Math.floor(piece.length / 2);
      const lastSpace = piece.lastIndexOf(" ", mid);
      const splitAt = lastSpace > mid * 0.5 ? lastSpace : mid;
      queue.unshift(piece.slice(splitAt), piece.slice(0, splitAt));
      console.error(`  [seg ${idx}] split at ${splitAt}/${piece.length}, ${queue.length} pieces left`);
    }
  }

  if (queue.length > 0) {
    throw new Error(`seg ${idx}: exhausted retries with ${queue.length} unprocessed pieces`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (verbose) console.log(`  [seg ${idx}] OK in ${elapsed}s (${wavs.length} piece(s))`);
  return wavs;
}

// ── Concurrent pool ──
async function runAll(segments) {
  const results = new Array(segments.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < segments.length) {
      const i = next++;
      results[i] = await runSegment(i, segments[i]);
      done++;
      if (verbose) console.log(`  progress: ${done}/${segments.length}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(parallel, segments.length) }, worker));
  return results;
}

// ── WAV concatenation ──
function extractData(wav) {
  let off = 12;
  while (off < wav.length - 8) {
    const id = String.fromCharCode(wav[off], wav[off + 1], wav[off + 2], wav[off + 3]);
    const sz = wav.readUint32LE(off + 4);
    if (id === "data") return wav.subarray(off + 8, off + 8 + sz);
    off += 8 + sz;
    if (sz % 2 !== 0) off++;
  }
  throw new Error("No data chunk in WAV");
}

function makeSilence(sr, ms) {
  const samples = Math.floor(sr * ms / 1000);
  return Buffer.alloc(samples * 2, 0);
}

function concatWavs(wavBuffers, sr, gapMs) {
  const silence = gapMs > 0 ? makeSilence(sr, gapMs) : null;
  const parts = [];
  for (let i = 0; i < wavBuffers.length; i++) {
    const data = extractData(wavBuffers[i]);
    const aligned = data.length % 2 === 0 ? data : data.subarray(0, data.length - 1);
    parts.push(aligned);
    if (silence && i < wavBuffers.length - 1) parts.push(silence);
  }
  const pcm = Buffer.concat(parts);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUint32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUint32LE(16, 16);
  wav.writeUint16LE(1, 20);
  wav.writeUint16LE(1, 22);
  wav.writeUint32LE(sr, 24);
  wav.writeUint32LE(sr * 2, 28);
  wav.writeUint16LE(2, 32);
  wav.writeUint16LE(16, 34);
  wav.write("data", 36);
  wav.writeUint32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

// ── Main ──
// Cache stats up front, so a re-run immediately shows how much will be reused.
let cacheHits = 0;
if (cacheDir) {
  const files = (await readdir(cacheDir)).filter(f => f.endsWith(".wav"));
  const valid = new Set(files.map(f => f.slice(0, -4)));
  const needed = new Set(segments.map(s => pieceHash(s.text)));
  cacheHits = [...needed].filter(h => valid.has(h)).length;
  console.log(`Cache:      ${cacheDir}`);
  console.log(`            ${cacheHits}/${segments.length} whole segments already cached`);
  console.log("");
}

console.log("Starting parallel TTS...");
const wallStart = Date.now();
let results;
try {
  results = await runAll(segments);
} catch (e) {
  if (cacheDir) {
    console.error(`\nFailed: ${e.message}`);
    console.error("Completed pieces are kept in the cache — re-run the same command to retry only the missing parts.");
  }
  process.exit(1);
} finally {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

const wallElapsed = ((Date.now() - wallStart) / 1000).toFixed(1);
const allWavs = results.flat();
const sr = allWavs[0].readUint32LE(24);
const combined = concatWavs(allWavs, sr, gapMs);
const durationSec = (combined.length - 44) / (sr * 2);

console.log("");
console.log(`All ${results.length} segments (${allWavs.length} pieces) done in ${wallElapsed}s`);
console.log(`Duration:  ${Math.floor(durationSec / 60)}m ${Math.floor(durationSec % 60)}s`);
if (parseFloat(wallElapsed) >= 1) {
  console.log(`Speedup:   ${(durationSec / parseFloat(wallElapsed)).toFixed(2)}x real-time`);
} else {
  console.log(`Speedup:   fully cached (${wallElapsed}s wall time)`);
}

await writeFile(outputFile, combined);
console.log(`\nWrote ${outputFile} (${(combined.length / 1024 / 1024).toFixed(2)} MB)`);
