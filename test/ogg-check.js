// Encode a song to .ogg with the built-in encoder and compare with the original.
// node test/ogg-check.js <mono-or-stereo.f32 (interleaved N channels)> <channels> <rate> <out.ogg> [quality]
const fs = require('fs');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const [src, ch, rate, out, quality] = process.argv.slice(2);
const b = fs.readFileSync(src);
const all = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
const n = +ch, len = Math.floor(all.length / n);
const chans = [];
for (let c = 0; c < n; c++) { const a = new Float32Array(len); for (let i = 0; i < len; i++) a[i] = all[i * n + c]; chans.push(a); }
const t0 = Date.now();
const ogg = BSM.encodeOgg(chans, +rate, { quality: quality || 'balanced', title: 'test', artist: 'test' });
fs.writeFileSync(out, ogg);
console.log('encoded', len, 'samples in', ((Date.now() - t0) / 1000).toFixed(1) + 's ->', ogg.length, 'bytes', (ogg.length * 8 / (len / +rate) / 1000).toFixed(0) + ' kbps');
