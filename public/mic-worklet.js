class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let src = 0;
    while (src < ch.length) {
      const space = this.buf.length - this.n;
      const take = Math.min(space, ch.length - src);
      this.buf.set(ch.subarray(src, src + take), this.n);
      this.n += take;
      src += take;
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage({ pcm: out, rms: rmsOf(out) }, [out.buffer]);
        this.buf = new Float32Array(1024);
        this.n = 0;
      }
    }
    return true;
  }
}

function rmsOf(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
}

registerProcessor('mic-capture', MicCapture);
