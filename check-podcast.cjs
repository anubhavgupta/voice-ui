const j = require('./dgx-spark-buying-guide-podcast.json');
let over = 0, max = 0, digits = 0;
for (const s of j.segments) {
  if (s.text.length > 2000) { over++; console.log('OVER 2000:', s.id, s.text.length); }
  if (/\d/.test(s.text)) { digits++; console.log('DIGITS in seg', s.id); }
  max = Math.max(max, s.text.length);
}
const seqOk = j.segments.map(s => s.id).every((v, i) => v === i);
console.log('segments:', j.segments.length, '| max len:', max, '| over-2000:', over, '| digits:', digits, '| ids sequential:', seqOk);
